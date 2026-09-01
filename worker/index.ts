type Hit = { sessionId:number; seq:number; role:string; ts:string; horizon:string; snippet:string }
const terms = ['embedding','trigram','workflow','sqlite','import','vector','context','Thai-safe search']
const projects = ['session-search','session-viewer','lance-indexer','jsonl-lens']
const hits: Hit[] = Array.from({length: 36}, (_, i) => ({
  sessionId: 1000 + (i % 12), seq: 40 + i * 17, role: i % 3 === 0 ? 'user' : 'assistant',
  ts: `2026-08-${String(30 - Math.floor(i / 4)).padStart(2,'0')}T${String(8 + i % 10).padStart(2,'0')}:1${i % 10}:00Z`,
  horizon: i < 8 ? 'short · <30d' : i < 18 ? 'mid · 30–60d' : i < 28 ? 'long · 60–90d' : 'archive · 90d+',
  snippet: `${terms[i % terms.length]} is measured, bounded, and linked to the next context page. Project: ${projects[i % projects.length]}.`
}))
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-session-search-demo':'static-fixture'}})
const assets=(env:any,request:Request)=>env.ASSETS.fetch(request)
export default {async fetch(request:Request,env:any){const u=new URL(request.url);if(u.pathname==='/health')return json({ok:true,service:'session-search',mode:'static-fixture',storage:'none'});if(u.pathname==='/api/status')return json({sessions:120,events:720,projects:4,horizons:{short:24,mid:38,long:35,archive:23},note:'Fixture status — local engine reads a session-viewer SQLite index read-only.'});if(u.pathname==='/api/search'){const q=(u.searchParams.get('q')||'embedding').toLowerCase();const out=hits.filter(h=>`${h.snippet} ${h.role}`.toLowerCase().includes(q)||q.length<3).slice(0,12);return json({query:q,route:q.length<3?'unicode61':'trigram',hits:out.length?out:hits.slice(0,5)})}return assets(env,request)}}
