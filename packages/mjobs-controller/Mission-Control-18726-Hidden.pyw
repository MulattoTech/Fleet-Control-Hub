"""Hidden supervisor for the verified MJobs Mission Control API on port 18726.

The owner-protected Fleet Hub on 4320 does not depend on this service; the
read-only M-TechLabs export retains its unique mission/campaign evidence here.
"""
from pathlib import Path
import subprocess
import time
import traceback

PYTHON = Path(r"C:\Users\Dylan\AppData\Local\Programs\Python\Python312\python.exe")
LAUNCHER = Path(r"C:\Tools\AO-Fleet-Control\Run-Mission-Control.py")
REPO = Path(r"C:\Tools\Dev\MJobs")
LOG = Path(r"C:\Tools\AO-Fleet-Control\Mission-Control-18726-supervisor.log")


def log(message):
    with LOG.open("a", encoding="utf-8") as stream:
        stream.write(time.strftime("%Y-%m-%d %H:%M:%S ") + message + "\n")


if __name__ == "__main__":
    if not PYTHON.is_file() or not LAUNCHER.is_file() or not REPO.is_dir():
        log("Mission server prerequisites are unavailable; no process was started")
        raise SystemExit(2)
    while True:
        try:
            with LOG.open("a", encoding="utf-8") as stream:
                result = subprocess.run(
                    [str(PYTHON), str(LAUNCHER), "--root", str(REPO),
                     "--port", "18726", "--no-open", "--mission-control"],
                    cwd=REPO, stdin=subprocess.DEVNULL, stdout=stream,
                    stderr=subprocess.STDOUT,
                    creationflags=subprocess.CREATE_NO_WINDOW, check=False,
                )
            log("Verified Mission service exited with code " + str(result.returncode) + "; retrying in 10 seconds")
        except Exception:
            log(traceback.format_exc())
        time.sleep(10)
