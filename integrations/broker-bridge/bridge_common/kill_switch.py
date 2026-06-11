"""本地 kill switch：检测配置的 kill switch 文件是否存在。"""
from __future__ import annotations

import os


class LocalKillSwitch:
    def __init__(self, file_path: str):
        self.file_path = file_path

    def is_triggered(self) -> bool:
        return bool(self.file_path) and os.path.exists(self.file_path)
