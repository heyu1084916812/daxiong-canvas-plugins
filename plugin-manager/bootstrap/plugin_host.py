import sys
import os
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

import uvicorn

import main
from plugin_system import PluginHost


PLUGIN_HOST = PluginHost(main.app, main, BASE_DIR)
PLUGIN_RECORDS = list(PLUGIN_HOST.records.values())


if __name__ == "__main__":
    for record in PLUGIN_RECORDS:
        state = "loaded" if record.loaded else "disabled" if not record.enabled else "incompatible" if not record.compatible else "error"
        detail = record.error or record.reason
        print(f"[plugin] {record.plugin_id} {record.version}: {state}{' - ' + detail if detail else ''}")
    uvicorn.run(
        main.app,
        host="0.0.0.0",
        port=int(os.getenv("INFINITE_CANVAS_PORT", "3000")),
        ws_ping_interval=None,
        ws_ping_timeout=None,
    )
