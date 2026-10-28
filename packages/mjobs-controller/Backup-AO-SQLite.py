import os, sqlite3, pathlib, datetime, json
root=pathlib.Path(os.environ["USERPROFILE"])/".ao"/"data"
backup_root=pathlib.Path(r"C:\Tools\AO-Fleet-Control\backups")
timestamp=datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
folder=backup_root/("ao-pre-0146-"+timestamp)
folder.mkdir(parents=True,exist_ok=True)
source=root/"ao.db"
target=folder/"ao-consistent.db"
conn=sqlite3.connect(f"file:{source.as_posix()}?mode=ro",uri=True,timeout=15)
dest=sqlite3.connect(str(target))
conn.backup(dest,pages=8192,sleep=0.1)
check=dest.execute("PRAGMA quick_check").fetchone()[0]
dest.close()
conn.close()
if check!="ok":raise RuntimeError("AO SQLite backup quick_check failed: "+check)
report={"folder":str(folder),"backup":str(target),"quick_check":check,"bytes":target.stat().st_size}
(folder/"manifest.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
print(json.dumps(report))
