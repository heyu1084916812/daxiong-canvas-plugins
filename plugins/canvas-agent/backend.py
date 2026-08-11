from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path
from threading import Lock
from typing import Any, Dict

from fastapi import APIRouter, FastAPI, HTTPException


class CanvasAgentPlugin:
    def __init__(self, host: Dict[str, Any]):
        self.host = host
        self.plugin_id = "canvas-agent"
        self.enabled = False
        self.tasks: Dict[str, Dict[str, Any]] = {}
        self.running: Dict[str, asyncio.Task] = {}
        self.lock = Lock()
        self.data_dir = Path(host["plugin_data_root"]) / self.plugin_id
        self.llm = host["capabilities"]["llm.canvas.v1"]
        self.request_model = host["capabilities"]["models.canvas_llm_request.v1"]
        self.skills_path = self.data_dir / "skills.json"

    def _require_enabled(self) -> None:
        if not self.host["is_plugin_enabled"](self.plugin_id):
            raise HTTPException(status_code=503, detail="canvas-agent 插件当前已停用")

    def register(self, app: FastAPI) -> None:
        router = APIRouter(prefix="/api/plugins/canvas-agent", tags=["canvas-agent"])

        @router.post("/llm-tasks")
        async def create_llm_task(payload: Dict[str, Any], stream: bool = False):
            self._require_enabled()
            return self.create_task(payload, stream=stream)

        @router.get("/llm-tasks/{task_id}")
        async def get_llm_task(task_id: str):
            self._require_enabled()
            return self.task_snapshot(task_id)

        @router.delete("/llm-tasks/{task_id}")
        async def cancel_llm_task(task_id: str):
            self._require_enabled()
            task = self.running.get(task_id)
            if task and not task.done():
                task.cancel()
            with self.lock:
                current = self.tasks.get(task_id)
                if current and current["status"] not in {"succeeded", "failed"}:
                    current.update(status="cancelled", error="任务已取消", updated_at=time.time())
            return self.task_snapshot(task_id)

        @router.get("/skills")
        async def list_skills():
            self._require_enabled()
            return {"skills": self.list_skills()}

        @router.post("/skills")
        async def create_skill(payload: Dict[str, Any]):
            self._require_enabled()
            return self.save_skill(payload)

        @router.put("/skills/{skill_id}")
        async def update_skill(skill_id: str, payload: Dict[str, Any]):
            self._require_enabled()
            return self.save_skill(payload, skill_id=skill_id)

        @router.delete("/skills/{skill_id}")
        async def delete_skill(skill_id: str):
            self._require_enabled()
            self.delete_skill(skill_id)
            return {"ok": True, "id": skill_id}

        @router.post("/skills/{skill_id}/use")
        async def use_skill(skill_id: str):
            self._require_enabled()
            return self.mark_skill_used(skill_id)

        @router.get("/health")
        async def health():
            return self.health_check()

        app.include_router(router)

        # Reference v2.0 compatibility. New frontends use the namespaced routes above.
        legacy = APIRouter(tags=["canvas-agent-compat"])

        @legacy.post("/api/agent-llm-task")
        async def legacy_create_llm_task(payload: Dict[str, Any], stream: bool = False):
            self._require_enabled()
            return self.create_task(payload, stream=stream)

        @legacy.get("/api/agent-llm-task/{task_id}")
        async def legacy_get_llm_task(task_id: str):
            self._require_enabled()
            return self.task_snapshot(task_id)

        app.include_router(legacy)

    def create_task(self, payload: Dict[str, Any], stream: bool = False) -> Dict[str, Any]:
        request = self.request_model(**payload)
        task_id = f"canvas_agent_llm_{uuid.uuid4().hex}"
        now = time.time()
        with self.lock:
            self.tasks[task_id] = {
                "id": task_id,
                "plugin_id": self.plugin_id,
                "schema_version": 1,
                "type": "agent-llm",
                "status": "queued",
                "created_at": now,
                "updated_at": now,
                "result": None,
                "error": "",
                "stream_requested": bool(stream),
            }
        self.running[task_id] = asyncio.create_task(self._run_task(task_id, request))
        return {"task_id": task_id, "status": "queued"}

    async def _run_task(self, task_id: str, request: Any) -> None:
        with self.lock:
            self.tasks[task_id].update(status="running", updated_at=time.time())
        try:
            result = await self.llm(request)
            with self.lock:
                self.tasks[task_id].update(status="succeeded", result=result, updated_at=time.time())
        except asyncio.CancelledError:
            with self.lock:
                self.tasks[task_id].update(status="cancelled", error="任务已取消", updated_at=time.time())
            raise
        except Exception as exc:
            detail = getattr(exc, "detail", None) or str(exc)
            status_code = getattr(exc, "status_code", 500)
            with self.lock:
                self.tasks[task_id].update(
                    status="failed",
                    error=str(detail),
                    status_code=status_code,
                    updated_at=time.time(),
                )
        finally:
            self.running.pop(task_id, None)

    def task_snapshot(self, task_id: str) -> Dict[str, Any]:
        with self.lock:
            task = dict(self.tasks.get(task_id) or {})
        if not task:
            raise HTTPException(status_code=404, detail="Agent LLM 任务不存在，服务可能已重启")
        return task


    _CP1252_REVERSE = {
        0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
        0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91,
        0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98,
        0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F,
    }

    @staticmethod
    def _looks_like_mojibake(text: str) -> bool:
        s = str(text or "")
        if not s:
            return False
        cjk = sum(1 for ch in s if "一" <= ch <= "鿿")
        latin_high = sum(1 for ch in s if "À" <= ch <= "ɏ" or "Ḁ" <= ch <= "ỿ")
        cp1252_marks = sum(1 for ch in s if ord(ch) in CanvasAgentPlugin._CP1252_REVERSE)
        score = latin_high + cp1252_marks
        if score >= 2 and cjk == 0:
            return True
        if score >= 3 and score > cjk:
            return True
        return False

    @classmethod
    def _text_to_misdecoded_bytes(cls, text: str) -> bytes | None:
        out = bytearray()
        for ch in str(text or ""):
            code = ord(ch)
            if code <= 0xFF:
                out.append(code)
                continue
            mapped = cls._CP1252_REVERSE.get(code)
            if mapped is None:
                return None
            out.append(mapped)
        return bytes(out)

    @classmethod
    def _repair_mojibake_text(cls, value: Any, depth: int = 0) -> str:
        text = str(value or "")
        if not text or depth > 2 or not cls._looks_like_mojibake(text):
            return text
        raw = cls._text_to_misdecoded_bytes(text)
        if not raw:
            return text
        try:
            # UTF-8 bytes were incorrectly decoded as Latin-1/CP1252.
            fixed = raw.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            return text
        if not fixed or fixed == text:
            return text
        if cls._looks_like_mojibake(fixed):
            return cls._repair_mojibake_text(fixed, depth + 1)
        return fixed

    @classmethod
    def _normalize_skill_fields(cls, skill: Dict[str, Any] | None) -> Dict[str, Any] | None:
        if not isinstance(skill, dict):
            return skill
        next_skill = dict(skill)
        for key in ("name", "description", "content"):
            if key in next_skill and next_skill[key] is not None:
                next_skill[key] = cls._repair_mojibake_text(next_skill[key])
        return next_skill

    def _read_skills_unlocked(self) -> list[Dict[str, Any]]:
        if not self.skills_path.is_file():
            return []
        try:
            data = json.loads(self.skills_path.read_text(encoding="utf-8"))
            skills = data if isinstance(data, list) else []
            return [self._normalize_skill_fields(item) or item for item in skills if isinstance(item, dict)]
        except (OSError, ValueError, TypeError):
            return []

    def _write_skills_unlocked(self, skills: list[Dict[str, Any]]) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        temp_path = self.skills_path.with_suffix(".json.tmp")
        temp_path.write_text(json.dumps(skills, ensure_ascii=False, indent=2), encoding="utf-8")
        temp_path.replace(self.skills_path)

    @classmethod
    def _clean_skill(cls, payload: Dict[str, Any], current: Dict[str, Any] | None = None) -> Dict[str, Any]:
        now = int(time.time() * 1000)
        name = cls._repair_mojibake_text(str(payload.get("name") or (current or {}).get("name") or "")).strip()[:80]
        content = cls._repair_mojibake_text(str(payload.get("content") or (current or {}).get("content") or "")).strip()[:100000]
        description = cls._repair_mojibake_text(str(payload.get("description") or (current or {}).get("description") or "")).strip()[:300]
        if not name:
            raise HTTPException(status_code=400, detail="Skill 名称不能为空")
        if not content:
            raise HTTPException(status_code=400, detail="Skill 内容不能为空")
        return {
            "id": str((current or {}).get("id") or f"skill_{uuid.uuid4().hex}"),
            "schema_version": 1,
            "name": name,
            "description": description,
            "content": content,
            "created_at": int((current or {}).get("created_at") or now),
            "updated_at": now,
            "usage_count": int((current or {}).get("usage_count") or 0),
            "last_used_at": int((current or {}).get("last_used_at") or 0),
        }

    def list_skills(self) -> list[Dict[str, Any]]:
        with self.lock:
            skills = self._read_skills_unlocked()
        return sorted(skills, key=lambda item: (-int(item.get("last_used_at") or 0), str(item.get("name") or "").lower()))

    def save_skill(self, payload: Dict[str, Any], skill_id: str = "") -> Dict[str, Any]:
        with self.lock:
            skills = self._read_skills_unlocked()
            current = next((item for item in skills if item.get("id") == skill_id), None) if skill_id else None
            if skill_id and current is None:
                raise HTTPException(status_code=404, detail="Skill 不存在")
            skill = self._clean_skill(payload, current)
            duplicate = next((item for item in skills if item.get("id") != skill.get("id") and str(item.get("name") or "").lower() == skill["name"].lower()), None)
            if duplicate:
                raise HTTPException(status_code=409, detail="已存在同名 Skill")
            if current:
                skills = [skill if item.get("id") == skill_id else item for item in skills]
            else:
                skills.append(skill)
            self._write_skills_unlocked(skills)
        return skill

    def delete_skill(self, skill_id: str) -> None:
        with self.lock:
            skills = self._read_skills_unlocked()
            if not any(item.get("id") == skill_id for item in skills):
                raise HTTPException(status_code=404, detail="Skill 不存在")
            self._write_skills_unlocked([item for item in skills if item.get("id") != skill_id])

    def mark_skill_used(self, skill_id: str) -> Dict[str, Any]:
        with self.lock:
            skills = self._read_skills_unlocked()
            skill = next((item for item in skills if item.get("id") == skill_id), None)
            if not skill:
                raise HTTPException(status_code=404, detail="Skill 不存在")
            skill["usage_count"] = int(skill.get("usage_count") or 0) + 1
            skill["last_used_at"] = int(time.time() * 1000)
            self._write_skills_unlocked(skills)
            return dict(skill)

    def on_enable(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        if not self.skills_path.exists():
            self._write_skills_unlocked([])
        self.enabled = True

    def on_disable(self) -> None:
        self.enabled = False
        for task in list(self.running.values()):
            if not task.done():
                task.cancel()

    def health_check(self) -> Dict[str, Any]:
        return {
            "status": "healthy" if self.host["is_plugin_enabled"](self.plugin_id) else "disabled",
            "plugin_id": self.plugin_id,
            "schema_version": 1,
            "enabled": self.host["is_plugin_enabled"](self.plugin_id),
            "backend": "ok",
            "data_directory": str(self.data_dir),
            "running_tasks": sum(1 for task in self.running.values() if not task.done()),
        }


def create_plugin(host: Dict[str, Any]) -> CanvasAgentPlugin:
    return CanvasAgentPlugin(host)
