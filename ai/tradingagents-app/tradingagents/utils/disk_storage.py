import os
import json
from typing import Any, Optional
from tradingagents.default_config import DEFAULT_CONFIG

def get_storage_path(module_name: str, file_name: str) -> str:
    """
    获取指定模块在存储目录下的绝对路径。
    如果模块对应的子文件夹不存在，会自动创建。
    
    Args:
        module_name: 模块对应的子文件夹名称 (例如: 'memory', 'logs', 'cache')
        file_name: 文件名 (例如: 'bull_memory.json')
        
    Returns:
        文件的绝对路径
    """
    storage_dir = DEFAULT_CONFIG.get("storage_dir")
    module_dir = os.path.join(storage_dir, module_name)
    os.makedirs(module_dir, exist_ok=True)
    return os.path.join(module_dir, file_name)

def save_to_disk(module_name: str, file_name: str, data: Any) -> bool:
    """
    将数据持久化保存到磁盘（以 JSON 格式）。
    
    Args:
        module_name: 模块对应的子文件夹名称
        file_name: 文件名
        data: 需要保存的数据（必须可 JSON 序列化）
        
    Returns:
        是否保存成功
    """
    file_path = get_storage_path(module_name, file_name)
    try:
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4, ensure_ascii=False)
        return True
    except Exception as e:
        print(f"Error saving to disk {file_path}: {e}")
        return False

def load_from_disk(module_name: str, file_name: str, default_val: Any = None) -> Any:
    """
    从磁盘加载 JSON 数据。
    
    Args:
        module_name: 模块对应的子文件夹名称
        file_name: 文件名
        default_val: 文件不存在或解析失败时返回的默认值
        
    Returns:
        加载的数据，或 default_val
    """
    file_path = get_storage_path(module_name, file_name)
    if not os.path.exists(file_path):
        return default_val
    
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading from disk {file_path}: {e}")
        return default_val
