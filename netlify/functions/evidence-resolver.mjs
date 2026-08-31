import dns from 'node:dns/promises';
import net from 'node:net';

function json(body,status=200){
  return new Response(JSON.stringify(body),{status,headers:{
    'content-type':'application/json; charset=utf-8','cache-control':'no-store'
  }});
}

function normalizeHost(host=''){
  return String(host).trim().toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
}
function mappedIPv4FromIPv6(ip=''){
  const s=normalizeHost(ip); if(!s.startsWith('::ffff:')) return '';
  const tail=s.slice(7); if(net.isIP(tail)===4) return tail;
  const parts=tail.split(':');
  if(parts.length===2&&parts.every(p=>/^[0-9a-f]{1,4}$/i.test(p))){
    const a=parseInt(parts[0],16),b=parseInt(parts[1],16);
    return `${(a>>8)&255}.${a&255}.${(b>>8)&255}.${b&255}`;
  }
  return '';
}
function isBlockedIP(ip=''){
  const mapped=mappedIPv4FromIPv6(ip); if(mapped) return isBlockedIP(mapped);
  const kind=net.isIP(ip);
  if(kind===4){
    const o=ip.split('.').map(Number);
    if(o[0]===0||o[0]===10||o[0]===127) return true;
    if(o[0]===169&&o[1]===254) return true;
    if(o[0]===172&&o[1]>=16&&o[1]<=31) return true;
    if(o[0]===192&&o[1]===168) return true;
    if(o[0]===100&&o[1]>=64&&o[1]<=127) return true;
    if(o[0]>=224) return true;
    return false;
  }
  if(kind===6){
    const s=normalizeHost(ip);
    if(s==='::1'||s==='::') return true;
    if(/^f[cd][0-9a-f]{2}:/i.test(s)) return true;
    if(/^fe[89ab][0-9a-f]:/i.test(s)) return true;
    if(/^ff/i.test(s)) return true;
    return false;
  }
  return true;
}
function isBlockedHostLiteral(host=''){
  const h=normalizeHost(host);
  if(!h||h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')) return true;
  if(net.isIP(h)) return isBlockedIP(h);
  return false;
}
async function assertPublicUrl(raw){
  let u; try{u=new URL(raw);}catch{throw new Error('invalid_url');}
  if(!['http:','https:'].includes(u.protocol)) throw new Error('unsupported_protocol');
  if(u.username||u.password) throw new Error('userinfo_not_allowed');
  const host=normalizeHost(u.hostname);
  if(isBlockedHostLiteral(host)) throw new Error('blocked_host');
  if(!net.isIP(host)){
    let records; try{records=await dns.lookup(host,{all:true,verbatim:true});}
    catch{throw new Error('dns_failed');}
    if(!records.length||records.some(r=>isBlockedIP(r.address))) throw new Error('blocked_dns');
  }
  return u;
}
async function safeFetch(raw,opts={},maxRedirects=4,timeoutMs=9000){
  let current=await assertPublicUrl(raw);
  for(let i=0;i<=maxRedirects;i++){
    const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),timeoutMs);
    let res;
    try{
      res=await fetch(current.toString(),{
        ...opts,redirect:'manual',signal:ctrl.signal,
        headers:{
          'user-agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1 TwinTripEvidence/2.0',
          'accept-language':'zh-TW,zh;q=0.9,en;q=0.6',
          'accept':opts?.headers?.accept||'text/html,application/xhtml+xml;q=0.9,*/*;q=0.7',
          ...(opts.headers||{})
        }
      });
    }finally{clearTimeout(timer);}
    if([301,302,303,307,308].includes(res.status)){
      if(i===maxRedirects) throw new Error('too_many_redirects');
      const loc=res.headers.get('location'); if(!loc) throw new Error('redirect_without_location');
      current=await assertPublicUrl(new URL(loc,current).toString()); continue;
    }
    return {res,finalUrl:current.toString()};
  }
  throw new Error('redirect_failed');
}

function decodeHtml(s=''){
  return String(s).replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;/gi,"'")
    .replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&nbsp;/gi,' ')
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)));
}
function attr(tag,name){
  const m=tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`,'i'));
  return m?decodeHtml(m[1].trim()):'';
}
function metaContent(html,key){
  for(const tag of (String(html).match(/<meta\b[^>]*>/gi)||[])){
    const prop=(attr(tag,'property')||attr(tag,'name')).toLowerCase();
    if(prop===key.toLowerCase()) return attr(tag,'content');
  }
  return '';
}
function pageTitle(html=''){
  return (metaContent(html,'og:title')||metaContent(html,'twitter:title')||((String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||''))
    .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,220);
}
function htmlToText(html=''){
  return decodeHtml(String(html)
    .replace(/<!--[\s\S]*?-->/g,' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi,' ')
    .replace(/<br\s*\/?>/gi,'。')
    .replace(/<\/(p|li|div|section|article|tr|td|th|h[1-6]|dt|dd|summary)>/gi,'。')
    .replace(/<[^>]+>/g,' ')
    .replace(/\s+/g,' ')).trim();
}

function extractMainContentHtml(html=''){
  const src=String(html||'');
  const candidates=[];
  const pushTag=(tag,re,minLength=180)=>{let m;while((m=re.exec(src))&&candidates.length<24){const block=m[0];const text=htmlToText(block);if(text.length>=minLength)candidates.push({tag,block,text,hasH1:/<h1\b/i.test(block)});}};
  pushTag('article',/<article\b[^>]*>[\s\S]*?<\/article>/gi,80);
  pushTag('main',/<main\b[^>]*>[\s\S]*?<\/main>/gi,180);
  pushTag('content',/<(?:section|div)\b[^>]*(?:id|class)\s*=\s*["'][^"']*(?:article|news[-_ ]?content|detail|post[-_ ]?content|main[-_ ]?content|content[-_ ]?body|editor)[^"']*["'][^>]*>[\s\S]*?<\/(?:section|div)>/gi,80);
  if(!candidates.length)return {html:src,text:htmlToText(src),kind:'document'};
  const tagPriority={article:4,content:3,main:2,document:1};
  candidates.sort((a,b)=>Number(b.hasH1)-Number(a.hasH1)||(tagPriority[b.tag]||0)-(tagPriority[a.tag]||0)||b.text.length-a.text.length);
  const best=candidates[0];
  return {html:best.block,text:best.text,kind:best.tag};
}
function isGenericEntityName(name=''){
  const sem=semanticIdentityParts(name), n=normalizeText(coreEntityName(name));
  if(!n)return true;
  if(sem.theme.length<2 && sem.venue)return true;
  // Common descriptive venue names are not distinctive enough for body-only identity.
  // Exact/strong title matches can still verify them.
  if(sem.venue && /^(?:森林|親水|文化|海洋|兒童|親子|共融|運動|生態|中央|河濱|特色|主題)$/.test(sem.theme))return true;
  return /^(?:親子|兒童|特色|共融)?(?:公園|樂園|農場|飯店|酒店|民宿|博物館|美術館|水族館|海洋館|遊戲場)$/.test(n);
}
function isLikelyListPage(url='',title='',mainHtml=''){
  let path='';try{path=new URL(url).pathname.toLowerCase();}catch{}
  const t=normalizeText(title);
  if(/(?:搜尋結果|searchresults|新聞列表|消息列表|最新消息|全部消息|文章列表)/.test(t))return true;
  if(/(?:\/search(?:\/|$)|\/list(?:\/|$)|news_list|newslist|article_list)/.test(path))return true;
  const links=(String(mainHtml).match(/<a\b/gi)||[]).length;
  const headings=(String(mainHtml).match(/<h[1-6]\b/gi)||[]).length;
  return links>80 && headings>12;
}
function extractPublishedAt(html='',text=''){
  const metas=[
    /<meta\b[^>]*(?:property|name)=["'](?:article:published_time|date|pubdate|publishdate)["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<time\b[^>]*datetime=["']([^"']+)["']/i
  ];
  for(const re of metas){const m=String(html).match(re);if(m){const d=new Date(m[1]);if(!Number.isNaN(d.getTime()))return d.toISOString();}}
  const t=String(text||'');
  let m=t.match(/(20\d{2})[年\/\-.](\d{1,2})[月\/\-.](\d{1,2})/);
  if(m){const d=new Date(Number(m[1]),Number(m[2])-1,Number(m[3]));if(!Number.isNaN(d.getTime()))return d.toISOString();}
  m=t.match(/民國\s*(1\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if(m){const d=new Date(Number(m[1])+1911,Number(m[2])-1,Number(m[3]));if(!Number.isNaN(d.getTime()))return d.toISOString();}
  return '';
}
function evidenceAuthority({pageUrl='',officialUrl='',sourceUrls=[],seedReason=''}={}){
  let host='',path='';try{const u=new URL(pageUrl);host=normalizeHost(u.hostname);path=(u.pathname+u.search).toLowerCase();}catch{}
  const gov=/\.gov\.tw$/i.test(host);
  const operational=/(?:faq|\/qa(?:\/|$)|service|facility|amenit|visit|information|guide|accessib|無障礙|服務)/i.test(path);
  const newsLike=/(?:news|article|post|news_content)/i.test(path);
  let sourceType='web_source',authorityRank=40;
  if(officialUrl&&sameOrganization(pageUrl,officialUrl)){sourceType='official';authorityRank=operational?94:newsLike?88:90;}
  else if(gov){sourceType='government';authorityRank=operational?94:newsLike?88:90;}
  else if(seedReason==='official_transport_mirror'||seedReason==='organization_root'||seedReason==='common_path'){sourceType='official';authorityRank=operational?92:86;}
  else for(const src of sourceUrls||[])if(sameOrganization(pageUrl,src)){sourceType='verified_source';authorityRank=52;break;}
  return {sourceType,authorityRank};
}

function normalizeText(s=''){
  return String(s).normalize('NFKC').toLowerCase().replace(/臺/g,'台')
    .replace(/&[a-z]+;/gi,' ').replace(/[\s\-—–_·・,，.。:：;；()（）【】\[\]\/\\'"|]+/g,'').trim();
}
function coreEntityName(name=''){
  let s=String(name).normalize('NFKC').replace(/臺/g,'台').trim();
  s=s.replace(/[｜|].*$/,'').replace(/[-–—]\s*(?:有|無)?(?:公廁|廁所|停車|餐廳|住宿|親子).*$/,'');
  s=s.replace(/\([^)]*\)|（[^）]*）/g,' ');
  s=s.replace(/\b(?:官方網站|官方|官網)\b/gi,' ').replace(/\s+/g,' ').trim();
  return s;
}
function bigrams(s=''){
  const n=normalizeText(s); if(!n)return[]; if(n.length===1)return[n];
  const out=[];for(let i=0;i<n.length-1;i++)out.push(n.slice(i,i+2));return out;
}
function dice(a='',b=''){
  const A=bigrams(a),B=bigrams(b);if(!A.length||!B.length)return 0;
  const m=new Map();for(const x of A)m.set(x,(m.get(x)||0)+1);let hit=0;
  for(const y of B){const c=m.get(y)||0;if(c){hit++;m.set(y,c-1);}}
  return 2*hit/(A.length+B.length);
}
function semanticIdentityParts(name=''){
  const raw=normalizeText(coreEntityName(name));
  const venueTypes=['鐵道自行車','智能海洋館','海洋館','水族館','博物館','美術館','科學館','動物園','遊樂園','主題樂園','休閒農場','農場','親子館','遊戲場','公園','飯店','酒店','民宿','樂園'];
  const venue=venueTypes.find(v=>raw.includes(normalizeText(v)))||'';
  let theme=raw;
  if(venue) theme=theme.replace(normalizeText(venue),'');
  theme=theme.replace(/(?:新埔|公二|特色|主題|智能|休閒|親子|兒童|全台|全臺|首座|有公廁|無公廁)/g,'');
  return {raw,theme,venue:normalizeText(venue)};
}
function identityScore(name,title,body=''){
  const core=coreEntityName(name),n=normalizeText(core),t=normalizeText(title),b=normalizeText(body);
  if(!n)return 0;
  const generic=isGenericEntityName(core);
  let score=0;
  if(t===n) score=1;
  else if(t.includes(n)||n.includes(t)) score=Math.max(score,.88);
  else score=Math.max(score,dice(n,t));
  // Body-only identity is intentionally narrow: nearby/roundup articles often mention
  // a different attraction once (e.g. "順遊 Xpark"). A single body mention only
  // counts when it is clearly framed as the target's own FAQ/rules/service section;
  // otherwise require repeated target mentions. Generic names always need title support.
  const bodyOccurrences=(()=>{if(!n)return 0;let count=0,pos=0;while((pos=b.indexOf(n,pos))>=0){count++;pos+=Math.max(1,n.length);if(count>=4)break;}return count;})();
  const bodyIdentityContext=(()=>{
    const raw=String(body||'').normalize('NFKC').replace(/臺/g,'台');
    const coreRaw=coreEntityName(name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    if(!coreRaw)return false;
    const re=new RegExp(`${coreRaw}[^。；;\n]{0,24}(?:相關問題|常見問答|FAQ|Q\s*&?\s*A|參觀須知|入場須知|搭乘規則|服務資訊|設施資訊|使用規則)`,'i');
    return re.test(raw);
  })();
  if(!generic && (bodyOccurrences>=2||bodyIdentityContext)) score=Math.max(score,.91);
  const compact=n.replace(/(?:智能|特色|主題|休閒|親子|公二|公園|樂園|海洋館|博物館)$/,'');
  const compactOccurrences=(()=>{if(compact.length<4)return 0;let count=0,pos=0;while((pos=b.indexOf(compact,pos))>=0){count++;pos+=Math.max(1,compact.length);if(count>=4)break;}return count;})();
  if(!generic && compact.length>=4&&b.includes(compact)&&(compactOccurrences>=2||bodyIdentityContext)) score=Math.max(score,.72);
  const sem=semanticIdentityParts(core);
  if(sem.theme.length>=2&&sem.venue&&t.includes(sem.theme)&&t.includes(sem.venue)) score=Math.max(score,.84);
  if(!generic && n.length>=4){
    const grams=[...new Set(bigrams(n))];
    const hits=grams.filter(g=>b.includes(g)).length;
    const ratio=grams.length?hits/grams.length:0;
    if(hits>=2&&ratio>=0.55) score=Math.max(score,.68);
  }
  const relationalTitle=/(?:周邊|附近|順遊|鄰近|周遭|一日遊搭配|附近景點)/.test(t);
  if(relationalTitle&&bodyOccurrences<2&&!bodyIdentityContext)score=Math.min(score,.55);
  return Math.min(1,score);
}

function organizationKey(host=''){
  const h=normalizeHost(host);const p=h.split('.').filter(Boolean);
  if(p.length<=2)return h;
  const tw2=new Set(['com.tw','gov.tw','org.tw','edu.tw','net.tw','idv.tw','co.uk','org.uk']);
  const suffix=p.slice(-2).join('.');
  if(tw2.has(suffix)&&p.length>=3) return p.slice(-3).join('.');
  return p.slice(-2).join('.');
}
function sameOrganization(a,b){
  try{return organizationKey(new URL(a).hostname)===organizationKey(new URL(b).hostname);}catch{return false;}
}
function adminToken(v=''){
  const n=normalizeText(v);if(!n)return'';
  return n.replace(/(?:縣|市|區|鄉|鎮)$/,'');
}
function branchLocationMatches({county='',district='',name=''}={},title='',body=''){
  const t=normalizeText(title),b=normalizeText(body),d=adminToken(district),c=adminToken(county),n=normalizeText(coreEntityName(name));
  const countyTokens=['基隆','台北','新北','桃園','新竹','苗栗','台中','彰化','南投','雲林','嘉義','台南','高雄','屏東','宜蘭','花蓮','台東','澎湖','金門','連江','馬祖'];
  const targetCounty=c;
  const titleCounties=countyTokens.filter(x=>t.includes(x));
  if(targetCounty&&titleCounties.length&&titleCounties.every(x=>x!==targetCounty))return false;
  if(d&&d.length>=2&&t.includes(d))return true;
  if(c&&c.length>=2&&t.includes(c))return true;
  const loc=d&&d.length>=2?d:c;
  if(!loc)return false;
  // Body-only location must be contextual, not a footer/menu that merely lists all branches.
  if(n&&b.includes(n)&&b.includes(loc)){
    const ns=[];for(let p=0;(p=b.indexOf(n,p))>=0;p+=Math.max(1,n.length))ns.push(p);
    const ls=[];for(let p=0;(p=b.indexOf(loc,p))>=0;p+=Math.max(1,loc.length))ls.push(p);
    if(ns.some(a=>ls.some(z=>Math.abs(a-z)<=70)))return true;
  }
  const raw=String(body||'').normalize('NFKC').replace(/臺/g,'台');
  const escaped=String(district||county||'').replace(/[.*+?^${}()|[\]\\]/g,m=>`\\${m}`);
  if(escaped&&new RegExp(`(?:地址|位於|所在地|館址|店址)[^。；;\n]{0,36}${escaped}`).test(raw))return true;
  return false;
}
function commonBranchPolicy(text=''){
  return /(?:全台|全臺|所有|各)(?:門市|分店|據點|場館|館別)[^。；;]{0,20}?(?:皆|均|一律|適用|提供|可)|(?:適用於|適用)(?:全台|全臺|所有|各)(?:門市|分店|據點|場館)/.test(String(text));
}
function canonicalUrl(raw,base=''){
  try{
    const u=new URL(raw,base||undefined);if(!['http:','https:'].includes(u.protocol))return'';
    u.hash='';
    for(const k of [...u.searchParams.keys()]) if(/^utm_|^(fbclid|gclid|mc_cid|mc_eid)$/i.test(k))u.searchParams.delete(k);
    return u.toString();
  }catch{return'';}
}
function extractLinks(html='',baseUrl=''){
  const out=[];const seen=new Set();let m;
  const re=/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while((m=re.exec(String(html)))){
    const href=canonicalUrl(decodeHtml(m[1]),baseUrl);if(!href||seen.has(href))continue;
    const text=decodeHtml(String(m[2]||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()).slice(0,180);
    seen.add(href);out.push({href,text});
    if(out.length>=600)break;
  }
  return out;
}

const EVIDENCE_RE=/(推車|嬰兒車|娃娃推車|幼兒|嬰幼兒|學齡前|親子|兒童|孩童|適合|年齡|身高|\d{1,2}\s*足?歲|\d{2,3}\s*(?:公分|cm)|雨天|下雨|室內|館內|戶外|室外|無障礙|哺乳|哺集乳|育嬰|尿布|換尿布|尿布台|親子廁所|家庭廁所|坡道|電梯|全齡|分齡|不同年齡|各年齡|共融|嬰兒副食品|免費借用)/i;
function evidenceTextFromText(text=''){
  const parts=String(text).split(/[。！？!?；;]/).map(x=>x.trim()).filter(Boolean);
  const selected=[];const seen=new Set();
  for(let i=0;i<parts.length;i++){
    if(!EVIDENCE_RE.test(parts[i]))continue;
    for(let j=Math.max(0,i-1);j<=Math.min(parts.length-1,i+1);j++){
      const v=parts[j].slice(0,260);if(!v||seen.has(v))continue;seen.add(v);selected.push(v);
      if(selected.length>=90)break;
    }
    if(selected.length>=90)break;
  }
  return selected.join('。').slice(0,24000);
}
function evidenceKinds(text=''){
  const t=String(text);const out=[];
  const add=(k,re)=>{if(re.test(t))out.push(k);};
  add('stroller',/(推車|嬰兒車|娃娃推車)/);
  add('age',/(幼兒|嬰幼兒|兒童|孩童|年齡|身高|\d{1,2}\s*足?歲)/);
  add('environment',/(室內|館內|戶外|室外)/);
  add('rain',/(雨天|下雨)/);
  add('nursing',/(哺乳|哺集乳|育嬰|母嬰)/);
  add('changing',/(尿布|換尿布)/);
  add('family_restroom',/(親子廁所|家庭廁所)/);
  add('accessibility',/(無障礙|坡道|電梯)/);
  add('all_age',/(全齡|分齡|不同年齡|各年齡|共融)/);
  return out;
}

function linkScore(link,entityName,fromUrl,officialOrg){
  let score=0;const hay=`${link.text} ${link.href}`;const n=normalizeText(coreEntityName(entityName));const h=normalizeText(hay);
  if(n&&h.includes(n))score+=140;
  const short=n.replace(/(?:智能|特色|主題|休閒|親子|公二|公園|樂園|海洋館|博物館)$/,'');
  if(short.length>=4&&h.includes(short))score+=65;
  if(/FAQ|FAQs|常見問答|常見問題|問答|Q&A|問題|參觀|參觀資訊|遊園須知|購票須知|入場須知|須知|規則|服務|設施|館內|無障礙|友善|親子|兒童|幼兒|年齡|身高|票價|門票|嬰兒|推車|育嬰|哺乳|哺集乳|尿布|廁所|information|guide|visit|service|facility|accessibility|ticket|乘車|搭乘|騎乘|使用規則|注意事項|限制|\bqa\b/i.test(hay))score+=72;
  if(/官網|官方|海科館|博物館|home|index|首頁/i.test(hay))score+=24;
  if(/faqdetail|faq\/|information\/detail|content\/|service|facility|qa(?:\/|$)/i.test(link.href))score+=30;
  if(/news\/list|newslist|activity\/list/i.test(link.href)&&!h.includes(n))score-=25;
  try{
    if(organizationKey(new URL(link.href).hostname)===officialOrg)score+=18;
    if(new URL(link.href).origin!==new URL(fromUrl).origin)score-=3;
  }catch{}
  return score;
}
function genericSeeds(url){
  const out=[];try{
    const u=new URL(url);const origin=u.origin;
    for(const p of ['/qa','/faq','/information','/service'])out.push(canonicalUrl(p,origin));
  }catch{}
  return out.filter(Boolean);
}
function orgRootSeeds(url){
  const out=[];try{
    const u=new URL(url),key=organizationKey(u.hostname);
    if(key&&key!==u.hostname){out.push(`https://${key}/`);out.push(`https://www.${key}/`);}
  }catch{}
  return out;
}

// Some public-sector CMS deployments expose the same article through more than one
// official host. A primary host can reject/timeout serverless fetches even while an
// agency sibling host serves the same public record. These are organization transport
// adapters, not venue-specific evidence rules: article identity still has to verify.
const PUBLIC_ARTICLE_MIRROR_ROUTES={
  // Hsinchu County moved/republished selected county news records onto its official
  // tourism portal. This is transport-only routing: the crawler still requires the
  // destination page to pass normal identity, list-page, branch, and evidence checks.
  'hsinchu.gov.tw|273298':['https://travel.hsinchu.gov.tw/News/Content/RApPko96Pe64']
};
const PUBLIC_MIRROR_ADAPTERS={
  'hsinchu.gov.tw':(u)=>{
    const s=u.searchParams.get('s');if(!s)return[];
    const out=[];
    const mirror=new URL('https://iedd.hsinchu.gov.tw/News_Content.aspx');
    mirror.searchParams.set('n','109');mirror.searchParams.set('s',s);out.push(mirror.toString());
    out.push(...(PUBLIC_ARTICLE_MIRROR_ROUTES[`hsinchu.gov.tw|${s}`]||[]));
    return out;
  }
};
function genericTransportSeeds(url=''){
  const out=[];
  try{
    const u=new URL(url), host=normalizeHost(u.hostname), key=organizationKey(host);
    const add=(hostName)=>{const v=new URL(u.toString());v.protocol='https:';v.hostname=hostName;out.push(canonicalUrl(v.toString()));};
    if(host.startsWith('www.')) add(host.slice(4)); else add(`www.${host}`);
    if(key && key!==host){add(key);add(`www.${key}`);out.push(`https://${key}/`);out.push(`https://www.${key}/`);}
  }catch{}
  return [...new Set(out.filter(Boolean))];
}
function officialMirrorSeeds(url=''){
  const out=[];
  try{const u=new URL(url),key=organizationKey(u.hostname),adapter=PUBLIC_MIRROR_ADAPTERS[key];if(adapter)out.push(...adapter(u));}catch{}
  out.push(...genericTransportSeeds(url));
  return [...new Set(out.map(x=>canonicalUrl(x)).filter(Boolean))];
}

async function readTextLimited(res,maxBytes=1_300_000){
  const len=Number(res.headers.get('content-length')||0);
  if(Number.isFinite(len)&&len>maxBytes)throw new Error('response_too_large');
  if(!res.body?.getReader){
    const text=await res.text();
    if(new TextEncoder().encode(text).byteLength>maxBytes)throw new Error('response_too_large');
    return text;
  }
  const reader=res.body.getReader(),chunks=[];let total=0;
  try{
    while(true){
      const {done,value}=await reader.read();if(done)break;
      total+=value.byteLength;if(total>maxBytes){try{await reader.cancel()}catch{};throw new Error('response_too_large');}
      chunks.push(value);
    }
  }finally{try{reader.releaseLock()}catch{}}
  const all=new Uint8Array(total);let offset=0;for(const c of chunks){all.set(c,offset);offset+=c.byteLength;}
  return new TextDecoder('utf-8',{fatal:false}).decode(all);
}

async function fetchHtml(url){
  const {res,finalUrl}=await safeFetch(url,{method:'GET'},4,5200);
  if(!res.ok)return {ok:false,status:res.status,finalUrl};
  const ct=(res.headers.get('content-type')||'').toLowerCase();
  if(!ct.includes('text/html')&&!ct.includes('application/xhtml+xml'))return {ok:false,status:res.status,contentType:ct,finalUrl};
  const contentLength=Number(res.headers.get('content-length')||0);if(Number.isFinite(contentLength)&&contentLength>1_300_000)throw new Error('response_too_large');
  const html=await readTextLimited(res,1_300_000);
  const main=extractMainContentHtml(html);
  return {ok:true,finalUrl,html,title:pageTitle(html),text:main.text.slice(0,260000),mainHtml:main.html,mainKind:main.kind,publishedAt:extractPublishedAt(html,main.text)};
}

async function crawlEvidenceCore({name,sourceUrls=[],officialUrl='',county='',district='',branchRisk=false,maxPages=10,maxDepth=4,maxRuntimeMs=44000,loader=fetchHtml}={}){
  const entityName=String(name||'').trim();if(!entityName)throw new Error('name_required');
  const sources=[...new Set((Array.isArray(sourceUrls)?sourceUrls:[]).map(x=>canonicalUrl(String(x||''))).filter(Boolean))].slice(0,4);
  const official=canonicalUrl(officialUrl||'');
  const primary=official||sources[0]||'';if(!primary) return {ok:false,reason:'no_seed',evidenceVerified:false,pages:[]};
  const org=organizationKey(new URL(primary).hostname);

  const queue=[];let seq=0;const startedAt=Date.now();const deadline=startedAt+Math.max(8000,Math.min(50000,Number(maxRuntimeMs)||44000));
  const push=(url,depth,score,reason,seedType='nav')=>{
    const c=canonicalUrl(url);if(!c)return;
    queue.push({url:c,depth,score,reason,seedType,seq:seq++});
  };
  if(official){
    push(official,0,220,'google_place_website','official');
    for(const u of officialMirrorSeeds(official))push(u,0,210,'official_transport_mirror','official');
    for(const u of genericSeeds(official))push(u,1,55,'common_path','official-nav');
    for(const u of orgRootSeeds(official))push(u,1,70,'organization_root','official-nav');
  }
  for(const src of sources){
    push(src,0,official?150:205,'saved_source','source');
    for(const u of officialMirrorSeeds(src))push(u,0,official?145:198,'official_transport_mirror','official');
  }

  const visited=new Set(),pages=[],evidencePages=[];let fetchErrors=0;const fetchErrorDetails=[];
  let deadlineReached=false;
  while(queue.length&&pages.length<maxPages){
    if(Date.now()>=deadline){deadlineReached=true;break;}
    queue.sort((a,b)=>b.score-a.score||a.depth-b.depth||a.seq-b.seq);
    const item=queue.shift();if(!item||visited.has(item.url)||item.depth>maxDepth)continue;visited.add(item.url);
    let page;
    try{page=await loader(item.url);}
    catch(err){
      fetchErrors++;
      if(fetchErrorDetails.length<12)fetchErrorDetails.push({url:item.url,reason:String(err?.name==='AbortError'?'timeout':err?.message||'fetch_failed'),seed:item.reason});
      continue;
    }
    if(!page.ok){
      fetchErrors++;
      if(fetchErrorDetails.length<12)fetchErrorDetails.push({url:item.url,reason:`http_or_content_${page.status||'unknown'}${page.contentType?`_${page.contentType}`:''}`,seed:item.reason});
      continue;
    }
    const final=canonicalUrl(page.finalUrl);if(final&&visited.has(final)&&final!==item.url)continue;if(final)visited.add(final);
    const pageOrg=organizationKey(new URL(page.finalUrl).hostname);
    const sameOrg=pageOrg===org;
    const idScore=identityScore(entityName,page.title,page.text);
    const listLike=isLikelyListPage(page.finalUrl,page.title,page.mainHtml||page.html||'');
    const branchOk=!branchRisk||branchLocationMatches({county,district,name:entityName},page.title,page.text);
    const verified=idScore>=0.70 && !listLike && branchOk;
    const evText=verified?evidenceTextFromText(page.text):'';
    const kinds=evText?evidenceKinds(evText):[];
    const authority=evidenceAuthority({pageUrl:page.finalUrl,officialUrl:official,sourceUrls:sources,seedReason:item.reason});
    const rec={url:page.finalUrl,title:page.title,identityScore:Number(idScore.toFixed(3)),verified,listLike,branchOk,evidenceKinds:kinds,evidenceText:evText,depth:item.depth,reason:item.reason,publishedAt:page.publishedAt||'',...authority};
    pages.push(rec);
    if(verified&&evText)evidencePages.push(rec);

    if(item.depth>=maxDepth)continue;
    // Traverse only the official organization, or the original source's own origin at depth 0.
    const mayTraverse=sameOrg || (item.seedType==='source'&&item.depth===0);
    if(!mayTraverse)continue;
    const links=extractLinks(page.html,page.finalUrl);
    for(const link of links){
      let linkOrg='';try{linkOrg=organizationKey(new URL(link.href).hostname);}catch{continue;}
      if(sameOrg&&linkOrg!==org)continue;
      if(!sameOrg){try{if(new URL(link.href).origin!==new URL(page.finalUrl).origin)continue;}catch{continue;}}
      const s=linkScore(link,entityName,page.finalUrl,org);
      if(s<42)continue;
      push(link.href,item.depth+1,item.score*.18+s,'linked_page',sameOrg?'official-nav':'source-nav');
    }
  }

  // Rank field evidence by authority first, then recency, coverage and identity.
  const ts=(x)=>{const t=Date.parse(x||'');return Number.isFinite(t)?t:0;};
  evidencePages.sort((a,b)=>(b.authorityRank||0)-(a.authorityRank||0)||ts(b.publishedAt)-ts(a.publishedAt)||b.evidenceKinds.length-a.evidenceKinds.length||b.identityScore-a.identityScore||a.depth-b.depth);
  const combined=[];const seen=new Set();
  for(const p of evidencePages){
    for(const s of String(p.evidenceText||'').split('。').map(x=>x.trim()).filter(Boolean)){
      if(seen.has(s))continue;seen.add(s);combined.push(s);if(combined.length>=150)break;
    }
    if(combined.length>=150)break;
  }
  const evidenceText=combined.join('。').slice(0,42000);
  const best=evidencePages[0]||null;
  return {
    ok:!!evidencePages.length,
    reason:evidencePages.length?'evidence_found':'no_verified_evidence',
    evidenceVerified:!!evidencePages.length,
    pageTitle:best?.title||'',
    pageDescription:'',
    evidenceText,
    bestEvidenceUrl:best?.url||'',
    finalUrl:best?.url||official||sources[0]||'',
    titleVerified:!!best,
    bodyVerified:!!best,
    pagesScanned:pages.length,
    fetchErrors,
    fetchErrorDetails,
    runtimeMs:Date.now()-startedAt,
    deadlineReached,
    evidencePages:evidencePages.slice(0,10).map(p=>({url:p.url,title:p.title,identityScore:p.identityScore,evidenceKinds:p.evidenceKinds,evidenceText:p.evidenceText.slice(0,5000),sourceType:p.sourceType,authorityRank:p.authorityRank,publishedAt:p.publishedAt||'',reason:p.reason})),
    scannedPages:pages.slice(0,24).map(p=>({url:p.url,title:p.title,identityScore:p.identityScore,verified:p.verified,listLike:!!p.listLike,branchOk:p.branchOk!==false,evidenceKinds:p.evidenceKinds,depth:p.depth,reason:p.reason,sourceType:p.sourceType,authorityRank:p.authorityRank,publishedAt:p.publishedAt||''}))
  };
}

async function resolveEvidence(opts={}){return crawlEvidenceCore({...opts,loader:fetchHtml});}

export default async(req)=>{
  if(req.method!=='POST')return json({error:'method_not_allowed'},405);
  let body;try{body=await req.json();}catch{return json({error:'invalid_json'},400);}
  const name=String(body?.name||'').trim();
  const sourceUrls=Array.isArray(body?.sourceUrls)?body.sourceUrls.map(String):[];
  const officialUrl=String(body?.officialUrl||'').trim();
  const county=String(body?.county||'').trim(),district=String(body?.district||'').trim();const branchRisk=!!body?.branchRisk;
  if(!name)return json({error:'name_required'},400);
  if(name.length>160||sourceUrls.some(x=>x.length>2048)||officialUrl.length>2048||county.length>40||district.length>40)return json({error:'input_too_long'},400);
  try{return json(await resolveEvidence({name,sourceUrls,officialUrl,county,district,branchRisk,maxPages:10,maxDepth:4,maxRuntimeMs:44000}));}
  catch(err){return json({ok:false,error:'resolver_error',reason:String(err?.name==='AbortError'?'timeout':err?.message||'resolver_error')},200);}
};

export const __test={normalizeHost,mappedIPv4FromIPv6,isBlockedIP,isBlockedHostLiteral,normalizeText,coreEntityName,semanticIdentityParts,isGenericEntityName,dice,identityScore,organizationKey,sameOrganization,adminToken,branchLocationMatches,commonBranchPolicy,canonicalUrl,htmlToText,extractMainContentHtml,isLikelyListPage,extractPublishedAt,evidenceAuthority,evidenceTextFromText,evidenceKinds,extractLinks,linkScore,genericSeeds,orgRootSeeds,genericTransportSeeds,officialMirrorSeeds,readTextLimited,crawlEvidenceCore};
export const config={path:'/api/evidence-resolve',rateLimit:{windowLimit:12,windowSize:60,aggregateBy:['ip','domain']}};
