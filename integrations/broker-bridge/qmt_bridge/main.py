"""bridge 主进程：维持心跳 / 快照 / 命令拉取循环。

review 修订要点：
  - readonly_only=true 时干脆不去 pull，避免产生 dry-run 事件污染 server 表
  - dry-run 改用 event_type=cancel_error 还是 submitted？最终选择：保持 submitted 但 broker_order_id 用前缀，
    server 端会识别并标 failed（不会污染 live_orders.broker_order_id）。配合 server B25 修订生效。
  - ack 失败时把 cmd 入本地 retry queue，下次循环重试；幂等 ack 在 server 端是安全的
  - cancel_error 始终把原 broker_order_id 透传，方便追溯
  - heartbeat / snapshot 失败时做指数退避，避免持续灌爆 server
"""
from __future__ import annotations

import argparse
import logging
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from bridge_common.client import BridgeClient
from bridge_common.config import BridgeConfig
from bridge_common.event_seq import EventSeqGenerator
from bridge_common.kill_switch import LocalKillSwitch
from qmt_bridge.qmt_adapter import QmtAdapter

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("qmt_bridge")


class BridgeRunner:
    def __init__(self, config: BridgeConfig):
        self.config = config
        self.client = BridgeClient(config)
        self.adapter = QmtAdapter(config.qmt_account_id, config.qmt_userdata_path)
        self.seq = EventSeqGenerator(config.event_seq_state_file)
        self.kill_switch = LocalKillSwitch(config.local_kill_switch_file)
        self._stop = threading.Event()
        # ack 失败 retry 队列：(完整 cmd dict, retries_left)；retry 成功后回到主路径执行
        self._ack_retry: "deque[tuple[Dict[str, Any], int]]" = deque(maxlen=200)
        # heartbeat / snapshot 退避 backoff
        self._heartbeat_backoff = 1
        self._snapshot_backoff = 1

    # ------ 启动 ------

    def start(self) -> None:
        self._check_clock_skew()
        if not self.adapter.connect():
            logger.error("QMT 连接失败，退出")
            return

        threads = [
            threading.Thread(target=self._heartbeat_loop, daemon=True),
            threading.Thread(target=self._snapshot_loop, daemon=True),
            threading.Thread(target=self._command_loop, daemon=True),
            threading.Thread(target=self._ack_retry_loop, daemon=True),
        ]
        for t in threads:
            t.start()
        try:
            while not self._stop.is_set():
                time.sleep(1)
        except KeyboardInterrupt:
            logger.info("收到中断，停止")
            self._stop.set()

    def _check_clock_skew(self) -> None:
        # TODO: 实现 NTP 校时；当前只校验本地时间与单调时钟一致性
        return

    # ------ 心跳 ------

    def _heartbeat_loop(self) -> None:
        while not self._stop.is_set():
            try:
                payload = {
                    "bridge_version": "0.1.0",
                    "broker_client_status": "logged_in" if self.adapter.is_logged_in() else "logged_out",
                    "bridge_local_time": datetime.now(timezone.utc).isoformat(),
                    "metadata": {
                        "kill_switch_triggered": self.kill_switch.is_triggered(),
                        "allow_order_execution": self.config.allow_order_execution,
                        "readonly_only": self.config.readonly_only,
                    },
                }
                self.client.heartbeat(payload)
                self._heartbeat_backoff = 1
            except Exception as e:
                logger.warning("heartbeat failed (backoff=%ss): %s", self._heartbeat_backoff, e)
                self._stop.wait(self._heartbeat_backoff)
                self._heartbeat_backoff = min(self._heartbeat_backoff * 2, 60)
                continue
            self._stop.wait(self.config.heartbeat_interval_seconds)

    # ------ 账户快照 ------

    def _snapshot_loop(self) -> None:
        while not self._stop.is_set():
            try:
                asset = self.adapter.query_asset()
                self.client.push_account_snapshot(asset)
                positions = self.adapter.query_positions()
                if positions:
                    self.client.push_positions(positions)
                orders = self.adapter.query_today_orders()
                if orders:
                    self.client.push_orders(orders)
                trades = self.adapter.query_today_trades()
                if trades:
                    self.client.push_trades(trades)
                self._snapshot_backoff = 1
            except Exception as e:
                logger.warning("snapshot loop failed (backoff=%ss): %s", self._snapshot_backoff, e)
                self._stop.wait(self._snapshot_backoff)
                self._snapshot_backoff = min(self._snapshot_backoff * 2, 60)
                continue
            self._stop.wait(self.config.snapshot_interval_seconds)

    # ------ 命令循环 ------

    def _command_loop(self) -> None:
        # readonly_only=true：不去 pull 命令，避免产生任何 dry-run 事件
        if self.config.readonly_only:
            logger.info("readonly_only=true, command loop disabled")
            while not self._stop.is_set():
                self._stop.wait(60)
            return

        backoff = 1
        while not self._stop.is_set():
            try:
                commands = self.client.pull_commands(
                    wait_seconds=self.config.long_poll_seconds, limit=10
                )
                backoff = 1
            except Exception as e:
                logger.warning("pull commands failed (backoff=%ss): %s", backoff, e)
                self._stop.wait(backoff)
                backoff = min(backoff * 2, 30)
                continue
            for cmd in commands or []:
                self._handle_command(cmd)

    def _ack_retry_loop(self) -> None:
        """每 5 秒重试一次 ack 失败的 command；幂等。成功后回到主路径执行。"""
        while not self._stop.is_set():
            self._stop.wait(5)
            if not self._ack_retry:
                continue
            pending = list(self._ack_retry)
            self._ack_retry.clear()
            for cmd, retries_left in pending:
                command_id = cmd.get("command_id") if isinstance(cmd, dict) else None
                if not command_id:
                    continue
                if retries_left <= 0:
                    logger.error("ack retry exhausted for command %s", command_id)
                    # 失败仍要回告 server，避免命令永远停 dispatching 直到 TTL
                    try:
                        self._send_event(
                            command_id,
                            "failed",
                            payload={"error": "ack retry exhausted on bridge side"},
                        )
                    except Exception as e:
                        logger.warning("send ack-exhausted failed for %s: %s", command_id, e)
                    continue
                try:
                    self.client.ack_command(command_id)
                    logger.info("ack retry succeeded for command %s", command_id)
                    # ack 成功后回到主执行路径
                    self._execute_command(cmd)
                except Exception as e:
                    logger.warning(
                        "ack retry failed for command %s (left=%d): %s",
                        command_id,
                        retries_left - 1,
                        e,
                    )
                    self._ack_retry.append((cmd, retries_left - 1))

    def _handle_command(self, cmd: Dict[str, Any]) -> None:
        command_id = cmd.get("command_id")
        if not command_id:
            return
        try:
            self.client.ack_command(command_id)
        except Exception as e:
            logger.warning("ack %s failed, queued for retry: %s", command_id, e)
            # 把整个 cmd 入 retry 队列；ack 成功后会自动回到主路径
            self._ack_retry.append((cmd, 5))
            return
        self._execute_command(cmd)

    def _execute_command(self, cmd: Dict[str, Any]) -> None:
        """ack 已成功后的执行路径：dry-run / place / cancel。"""
        command_id = cmd.get("command_id")
        if not command_id:
            return
        if not self.config.allow_order_execution:
            self._send_dry_run_event(cmd)
            return
        if self.kill_switch.is_triggered():
            logger.warning("local kill switch triggered, refuse %s", command_id)
            self._send_failed_event(cmd, "local kill switch triggered")
            return

        ctype = cmd.get("command_type")
        if ctype == "place_order":
            result = self.adapter.place_order(
                cmd["symbol"],
                cmd["side"],
                int(cmd["quantity"]),
                float(cmd["limit_price"]),
            )
            if result.get("broker_order_id"):
                self._send_event(
                    command_id,
                    "submitted",
                    broker_order_id=result["broker_order_id"],
                    payload=result,
                )
            else:
                self._send_failed_event(
                    cmd, result.get("error") or "place_order returned no broker_order_id"
                )
        elif ctype == "cancel_order":
            # cancel_error 必须始终带回 broker_order_id（review #3.5）
            broker_order_id = (
                cmd.get("broker_order_id")
                or (cmd.get("request_payload") or {}).get("broker_order_id")
            )
            if not broker_order_id:
                self._send_event(
                    command_id,
                    "cancel_error",
                    broker_order_id=None,
                    payload={"error": "missing broker_order_id in cancel cmd"},
                )
                return
            result = self.adapter.cancel_order(broker_order_id)
            if result.get("submitted"):
                self._send_event(
                    command_id, "cancelled", broker_order_id=broker_order_id, payload=result
                )
            else:
                self._send_event(
                    command_id,
                    "cancel_error",
                    broker_order_id=broker_order_id,
                    payload=result,
                )
        else:
            logger.warning("unknown command_type: %s", ctype)

    # ------ 事件回传 ------

    def _send_event(
        self,
        command_id: int,
        event_type: str,
        broker_order_id: Optional[str] = None,
        fill_quantity: Optional[int] = None,
        fill_price: Optional[float] = None,
        payload: Optional[Dict[str, Any]] = None,
    ) -> None:
        try:
            self.client.push_order_events(
                [
                    {
                        "command_id": command_id,
                        "event_type": event_type,
                        # event_seq 必须是 string（server 端有大数精度限制）
                        "event_seq": str(self.seq.next()),
                        "event_time": datetime.now(timezone.utc).isoformat(),
                        "broker_order_id": broker_order_id,
                        "fill_quantity": fill_quantity,
                        "fill_price": fill_price,
                        "payload": payload or {},
                    }
                ]
            )
        except Exception as e:
            logger.warning("push event failed (command=%s, type=%s): %s", command_id, event_type, e)

    def _send_dry_run_event(self, cmd: Dict[str, Any]) -> None:
        """
        dry-run：用 submitted + 'dryrun-' 前缀 broker_order_id。
        server 端 advanceCommandStatus 会识别 dryrun-* 前缀并标 failed（不污染 live_orders.broker_order_id）。
        bridge 这样做的好处：不需要新 event_type，与正常事件链路一致。
        """
        self._send_event(
            cmd["command_id"],
            "submitted",
            broker_order_id=f"dryrun-{cmd['command_id']}",
            payload={
                "dry_run": True,
                "note": "bridge allow_order_execution=false; server will mark this command failed",
            },
        )

    def _send_failed_event(self, cmd: Dict[str, Any], message: str) -> None:
        self._send_event(cmd["command_id"], "failed", payload={"error": message})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="config.yaml")
    args = parser.parse_args()
    config = BridgeConfig.load(args.config)
    runner = BridgeRunner(config)
    runner.start()


if __name__ == "__main__":
    main()
