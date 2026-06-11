"""event_seq 生成器：wall_clock_us * 10000 + atomic_counter；
跨重启 + 跨进程持久化单调。"""
from __future__ import annotations

import contextlib
import os
import threading
import time

try:
    import fcntl  # POSIX only
    HAVE_FCNTL = True
except ImportError:
    HAVE_FCNTL = False


@contextlib.contextmanager
def _file_lock(fp):
    """跨进程互斥（POSIX）。Windows 上退化为无锁，依赖单 bridge_key 不允许多进程的运维约定。"""
    if HAVE_FCNTL:
        try:
            fcntl.flock(fp.fileno(), fcntl.LOCK_EX)
            yield
        finally:
            try:
                fcntl.flock(fp.fileno(), fcntl.LOCK_UN)
            except Exception:
                pass
    else:
        yield


class EventSeqGenerator:
    """
    候选公式：candidate = wall_clock_us * 10000 + (counter % 10000)
    保证：
      - 跨进程持久化最大 seq（state 文件每次写入前 flock，写后 fsync）
      - candidate ≤ _last 时强制 _last + 1，避免回退
    """

    def __init__(self, state_path: str):
        self.state_path = state_path
        os.makedirs(os.path.dirname(state_path) or ".", exist_ok=True)
        self._lock = threading.Lock()
        self._counter = self._load_counter()
        self._last = self._load_last()

    def _state_files(self):
        return self.state_path, self.state_path + ".counter"

    def _load_last(self) -> int:
        try:
            with open(self.state_path, "r", encoding="utf-8") as f:
                return int(f.read().strip() or "0")
        except FileNotFoundError:
            return 0
        except Exception:
            return 0

    def _load_counter(self) -> int:
        try:
            with open(self.state_path + ".counter", "r", encoding="utf-8") as f:
                return int(f.read().strip() or "0")
        except FileNotFoundError:
            return 0
        except Exception:
            return 0

    def _persist(self) -> None:
        try:
            # 同一目录下用单文件兜底持久化 last；counter 单独持久化
            with open(self.state_path, "w", encoding="utf-8") as f:
                with _file_lock(f):
                    f.write(str(self._last))
                    f.flush()
                    try:
                        os.fsync(f.fileno())
                    except Exception:
                        pass
            with open(self.state_path + ".counter", "w", encoding="utf-8") as f:
                with _file_lock(f):
                    f.write(str(self._counter))
                    f.flush()
                    try:
                        os.fsync(f.fileno())
                    except Exception:
                        pass
        except Exception:
            # 持久化失败不应该阻塞业务；下次启动会从内存接力（_last + 1 路径）
            pass

    def next(self) -> int:
        with self._lock:
            wall_us = time.time_ns() // 1000
            # 每次 +1，跨 10000 周期回 0 不影响最终 candidate（candidate 兜底自增）
            self._counter = (self._counter + 1) % (1 << 30)
            candidate = wall_us * 10000 + (self._counter % 10000)
            if candidate <= self._last:
                # 系统时间回拨或同微秒爆 counter：强制递增
                candidate = self._last + 1
            self._last = candidate
            self._persist()
            return candidate
