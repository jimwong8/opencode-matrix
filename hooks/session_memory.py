"""OpenCode Hook - Session Memory集成"""

import asyncio
import json
import logging
import os
from pathlib import Path

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def on_session_start(context: dict):
    """会话开始时的Hook"""
    try:
        from session_memory_client import get_client

        client = get_client()
        session_id = context.get("session_id", "unknown")

        # 创建会话
        await client.create_session(
            session_id=session_id,
            metadata={
                "project_path": context.get("project_path", ""),
                "start_time": context.get("timestamp", ""),
            },
        )

        logger.info(f"会话已创建: {session_id}")

        # 尝试同步离线队列
        synced = await client.sync_offline_queue()
        if synced > 0:
            logger.info(f"已同步 {synced} 条离线数据")

    except Exception as e:
        logger.error(f"会话开始Hook失败: {e}")


async def on_message(context: dict):
    """消息发送时的Hook"""
    try:
        from session_memory_client import get_client

        client = get_client()
        session_id = context.get("session_id", "unknown")
        role = context.get("role", "user")
        content = context.get("content", "")

        # 添加消息
        await client.add_message(
            session_id=session_id,
            role=role,
            content=content,
            metadata={
                "timestamp": context.get("timestamp", ""),
                "model": context.get("model", ""),
            },
        )

        logger.info(f"消息已记录: {session_id} - {role}")

    except Exception as e:
        logger.error(f"消息Hook失败: {e}")


async def on_session_end(context: dict):
    """会话结束时的Hook"""
    try:
        from session_memory_client import get_client

        client = get_client()

        # 最后一次同步离线队列
        synced = await client.sync_offline_queue()
        if synced > 0:
            logger.info(f"会话结束时同步了 {synced} 条离线数据")

        await client.close()
        logger.info("会话已结束，客户端已关闭")

    except Exception as e:
        logger.error(f"会话结束Hook失败: {e}")


# Hook注册
HOOKS = {
    "session_start": on_session_start,
    "message": on_message,
    "session_end": on_session_end,
}
