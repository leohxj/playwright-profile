#!/usr/bin/env python3
"""Read only source staging, then SQLite ONLINE BACKUP. Never open source in SQLite."""
import json, os, pathlib, shutil, sqlite3, sys, tempfile, time
source, destination = map(pathlib.Path, sys.argv[1:3])

def signature(p):
    try:
        s = p.stat()
        return [s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns]
    except FileNotFoundError:
        return None

try:
    with tempfile.TemporaryDirectory(dir=destination.parent, prefix='.sqlite-') as tmp:
        staged = pathlib.Path(tmp) / 'db'
        for attempt in range(3):
            members = [source, pathlib.Path(str(source) + '-wal'), pathlib.Path(str(source) + '-journal')]
            before = [signature(p) for p in members]
            for p, sig in zip(members, before):
                out = pathlib.Path(str(staged) + (str(p)[len(str(source)):] if p != source else ''))
                if out.exists():
                    out.unlink()
                if sig is not None:
                    if p.is_symlink() or not p.is_file():
                        raise ValueError('unsafe SQLite member')
                    shutil.copyfile(p, out)
                    os.chmod(out, 0o600)
            if before == [signature(p) for p in members]:
                break
        else:
            raise ValueError('source changed during staging')
        db = sqlite3.connect(str(staged), timeout=10)
        db.execute('PRAGMA query_only=ON')
        if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise ValueError('SQLite corruption')
        out = sqlite3.connect(str(destination))
        db.backup(out)
        if out.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise ValueError('backup corruption')
        out.close()
        result = {'cookies': [], 'cookie_table': False}
        if db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='cookies'").fetchone():
            result['cookie_table'] = True
            columns = {r[1] for r in db.execute('PRAGMA table_info(cookies)')}
            required = {'host_key','name','path','expires_utc','value','encrypted_value'}
            if not required.issubset(columns):
                raise ValueError('unknown cookie schema')
            fields = 'host_key,name,path,expires_utc,length(value)'
            fields += ',top_frame_site_key' if 'top_frame_site_key' in columns else ",''"
            for host, name, path, expires, plain, partition in db.execute('SELECT '+fields+' FROM cookies'):
                if expires and expires / 1000000 - 11644473600 <= time.time():
                    continue
                result['cookies'].append({'domain':host,'name':name,'path':path,'plaintextNonempty':bool(plain),'partition':partition})
        db.close()
        os.chmod(destination, 0o600)
        print(json.dumps(result))
except Exception:
    print('SQLite snapshot or integrity validation failed', file=sys.stderr)
    sys.exit(1)
