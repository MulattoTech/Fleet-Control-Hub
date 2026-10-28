import urllib.request, pathlib, json
base='https://raw.githubusercontent.com/OrchestratorInc/agent-orchestrator/v0.14.6/'
folder=pathlib.Path(r'C:\Tools\AO-Fleet-Control\diagnostics\ao-0146-source');folder.mkdir(parents=True,exist_ok=True)
files=['backend/internal/session_manager/manager.go','backend/internal/httpd/controllers/sessions.go','backend/internal/service/session/service.go']
for name in files:
    p=folder/(name.replace('/','-'))
    if not p.exists():
        p.write_bytes(urllib.request.urlopen(base+name,timeout=15).read())
    t=p.read_text(encoding='utf-8')
    if name.endswith('manager.go'):
        start=t.find('func (m *Manager) resumeAgentWithMode')
        end=t.find('\nfunc ',start+10)
        print('RESUME MANAGER', t[start:end][:17000])
    elif name.endswith('sessions.go'):
        print('RECOVERY ROUTES')
        for line in t.splitlines():
            if 'r.' in line and any(k in line.lower() for k in ['replace','restart','switch','resume','recover','transition']): print(line)
    else:
        print('SERVICE TYPES')
        for term in ['ReplaceSession','Replacement','ReplaceInput','func (s *Service) ResumeAgent']:
            start=t.find(term)
            if start>=0: print(t[max(0,start-150):start+1200])
