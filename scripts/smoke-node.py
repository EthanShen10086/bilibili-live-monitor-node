#!/usr/bin/env python3
"""Exercise managed CLI in a temporary root; no service install or real sends."""
import datetime, json, os, pathlib, re, shutil, subprocess, tempfile, time
repo = pathlib.Path(__file__).resolve().parents[1]
project = repo / 'node' if (repo / 'node').is_dir() else repo
bundled = project / '.runtime/node_modules/node/bin/node'
node = os.environ.get('MONITOR_NODE') or (str(bundled) if bundled.exists() else shutil.which('node'))
if not node or subprocess.check_output([node, '-p', 'process.versions.node.split(".")[0]'], text=True).strip() != '24':
    raise SystemExit('Node 24 required; set MONITOR_NODE to its executable.')
with tempfile.TemporaryDirectory(prefix='node-managed-safety-') as tmp:
    root = pathlib.Path(tmp)
    today = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoweekday()
    cfg = (project / 'config.yaml').read_text()
    cfg = re.sub(r'(?m)^  weekdays:.*$', f'  weekdays: [{(today + 1) % 7 + 1}]', cfg)
    cfg = cfg.replace('active: local', 'active: cloud').replace('mode: official', 'mode: polling').replace('mode: feishu_private', 'mode: feishu_group')
    cfg = re.sub(r'(?m)^    webhook_env:.*$', '    webhook_env: FEISHU_WEBHOOK', cfg)
    cfg = re.sub(r'(?m)^    secret_env:.*$', '    secret_env: FEISHU_WEBHOOK_SECRET', cfg)
    (root / 'config.yaml').write_text(cfg)
    env = dict(os.environ, FEISHU_WEBHOOK='https://open.feishu.cn/open-apis/bot/v2/hook/fake', FEISHU_WEBHOOK_SECRET='fake')
    p = subprocess.Popen([node, str(project / 'dist/src/cli.js'), '--root', str(root), 'run', '--managed', 'cloud'], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        ready = False
        for _ in range(100):
            time.sleep(.05)
            try:
                s = json.loads((root / 'var/status.json').read_text())
                ready = s.get('detector_state') == 'outside_window' and s.get('resource_safety_version') == 1
                if ready: break
            except (FileNotFoundError, json.JSONDecodeError): pass
            if p.poll() is not None: break
        assert ready, 'CLI worker not ready; inspect temporary managed logs'
        p.terminate()
        out, err = p.communicate(timeout=5)
        assert p.returncode == 0, (out, err)
        assert out == b'' and err == b''
        assert (root / 'var/service.log').exists() and (root / 'var/error.log').exists()
        assert not json.loads((root / 'var/status.json').read_text())['running']
        print('Node managed CLI: safety marker, bounded outputs and graceful exit passed; no real sends.')
    finally:
        if p.poll() is None: p.kill(); p.wait()
