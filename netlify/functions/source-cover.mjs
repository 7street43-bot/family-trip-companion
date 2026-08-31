
import dns from 'node:dns/promises';
import net from 'node:net';

function json(body,status=200){
  return new Response(JSON.stringify(body),{
    status,
    headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}
  });
}

function normalizeText(s=''){
  return String(s).normalize('NFKC').toLowerCase().replace(/臺/g,'台')
    .replace(/&[a-z]+;/gi,' ')
    .replace(/[\s\-—–_·・,，.。:：;；()（）【】\[\]\/\\'"|]+/g,'')
    .trim();
}
function bigrams(s=''){
  const n=normalizeText(s);
  if(!n) return [];
  if(n.length===1) return [n];
  const out=[]; for(let i=0;i<n.length-1;i++) out.push(n.slice(i,i+2));
  return out;
}
function dice(a='',b=''){
  const A=bigrams(a),B=bigrams(b);
  if(!A.length||!B.length) return 0;
  const counts=new Map();
  for(const x of A) counts.set(x,(counts.get(x)||0)+1);
  let hits=0;
  for(const y of B){const c=counts.get(y)||0;if(c){hits++;counts.set(y,c-1);}}
  return 2*hits/(A.length+B.length);
}
function titleSimilarity(a='',b=''){
  const x=normalizeText(a),y=normalizeText(b);
  if(!x||!y) return 0;
  if(x===y) return 1;
  if(y.includes(x)||x.includes(y)){
    const ratio=Math.min(x.length,y.length)/Math.max(x.length,y.length);
    return Math.max(0.78,Math.min(0.99,0.72+ratio*0.27));
  }
  return dice(x,y);
}
function decodeHtml(s=''){
  return String(s).replace(/&amp;/gi,'&').replace(/&quot;/gi,'"')
    .replace(/&#39;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)));
}
function attr(tag,name){
  const m=tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`,'i'));
  return m?decodeHtml(m[1].trim()):'';
}
function metaContent(html,key){
  for(const tag of (html.match(/<meta\b[^>]*>/gi)||[])){
    const prop=(attr(tag,'property')||attr(tag,'name')).toLowerCase();
    if(prop===key.toLowerCase()) return attr(tag,'content');
  }
  return '';
}
function pageTitle(html=''){
  return (metaContent(html,'og:title')||metaContent(html,'twitter:title')||
    ((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||''))
    .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
}
function pageDescription(html=''){
  return (metaContent(html,'og:description')||metaContent(html,'twitter:description')||metaContent(html,'description')||'')
    .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,1200);
}
function identityTextFromHtml(html=''){
  return decodeHtml(String(html)
    .replace(/<!--[\s\S]*?-->/g,' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/\s+/g,' ')).trim().slice(0,200000);
}
function evidenceTextFromHtml(html=''){
  const clean=decodeHtml(String(html)
    .replace(/<!--[\s\S]*?-->/g,' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi,' ')
    .replace(/<br\s*\/?>/gi,'。')
    .replace(/<\/p>|<\/li>|<\/div>|<\/section>|<\/tr>|<\/h[1-6]>/gi,'。')
    .replace(/<[^>]+>/g,' ')
    .replace(/\s+/g,' '));
  const keys=/(推車|嬰兒車|幼兒|嬰幼兒|學齡前|親子|兒童|適合|年齡|身高|\d{1,2}\s*歲|\d{2,3}\s*(?:公分|cm)|雨天|下雨|室內|館內|戶外|室外|無障礙|哺乳|哺集乳|育嬰|尿布|換尿布|尿布台|親子廁所|坡道|電梯|全齡|分齡|不同年齡|各年齡|共融)/;
  const parts=clean.split(/[。！？!?；;]/).map(x=>x.trim()).filter(x=>x&&keys.test(x));
  const seen=new Set(), out=[];
  for(const x of parts){const v=x.slice(0,220); if(seen.has(v)) continue; seen.add(v); out.push(v); if(out.length>=48) break;}
  return out.join('。').slice(0,12000);
}
function relatedEvidenceLinks(html='',baseUrl=''){
  let base; try{base=new URL(baseUrl);}catch{return [];}
  const out=[]; const seen=new Set();
  const re=/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  const key=/(FAQ|FAQs|常見問答|常見問題|問答|問題|參觀|參觀資訊|遊園須知|須知|規則|服務|設施|館內|無障礙|友善|親子|兒童|幼兒|年齡|身高|票價|門票|交通|嬰兒|推車|育嬰|哺乳|哺集乳|尿布|information|guide|visit|service|facility|accessibility|ticket|\bqa\b)/i;
  while((m=re.exec(html))){
    const text=decodeHtml(String(m[2]||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());
    let u; try{u=new URL(m[1],base);}catch{continue;}
    if(!key.test(`${text} ${u.pathname} ${u.search}`)) continue;
    if(u.origin!==base.origin || !['http:','https:'].includes(u.protocol)) continue;
    u.hash=''; const href=u.toString();
    if(seen.has(href)) continue; seen.add(href); out.push(href);
    if(out.length>=12) break;
  }
  return out;
}
async function collectRelatedEvidence(html='',baseUrl='',limit=6){
  const links=relatedEvidenceLinks(html,baseUrl).slice(0,limit);
  const chunks=[];
  for(const url of links){
    try{
      const {res}=await safeFetch(url,{method:'GET',headers:{'accept':'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'}},3);
      if(!res.ok) continue;
      const ct=(res.headers.get('content-type')||'').toLowerCase();
      if(!ct.includes('text/html')&&!ct.includes('application/xhtml+xml')) continue;
      const page=await readTextLimited(res,700_000);
      const text=evidenceTextFromHtml(page); if(text) chunks.push(text);
    }catch(_){ }
  }
  return chunks.join('。').slice(0,18000);
}
function imageFromHtml(html=''){
  return metaContent(html,'og:image:secure_url')||metaContent(html,'og:image')||
    metaContent(html,'twitter:image')||metaContent(html,'twitter:image:src')||'';
}
function normalizeHost(host=''){
  return String(host).trim().toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
}
function mappedIPv4FromIPv6(ip=''){
  const s=normalizeHost(ip);
  if(!s.startsWith('::ffff:')) return '';
  const tail=s.slice(7);
  if(net.isIP(tail)===4) return tail;
  const parts=tail.split(':');
  if(parts.length===2 && parts.every(p=>/^[0-9a-f]{1,4}$/i.test(p))){
    const a=parseInt(parts[0],16),b=parseInt(parts[1],16);
    return `${(a>>8)&255}.${a&255}.${(b>>8)&255}.${b&255}`;
  }
  return '';
}
function isBlockedIP(ip=''){
  const mapped=mappedIPv4FromIPv6(ip);
  if(mapped) return isBlockedIP(mapped);
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
async function safeFetch(raw,opts={},maxRedirects=4){
  let current=await assertPublicUrl(raw);
  for(let i=0;i<=maxRedirects;i++){
    const res=await fetch(current.toString(),{
      ...opts,redirect:'manual',
      headers:{
        'user-agent':'Mozilla/5.0 compatible; TwinTripCoverBot/4.2.5.1',
        'accept':opts?.headers?.accept||'*/*',...(opts.headers||{})
      }
    });
    if([301,302,303,307,308].includes(res.status)){
      if(i===maxRedirects) throw new Error('too_many_redirects');
      const loc=res.headers.get('location');
      if(!loc) throw new Error('redirect_without_location');
      current=await assertPublicUrl(new URL(loc,current).toString());
      continue;
    }
    return {res,finalUrl:current.toString()};
  }
  throw new Error('redirect_failed');
}
async function readTextLimited(res,maxBytes){
  const limit=Math.max(1024,Number(maxBytes)||1_500_000);
  const len=Number(res.headers.get('content-length')||0);
  if(len&&len>limit) throw new Error('response_too_large');
  if(!res.body?.getReader){
    const text=await res.text();
    if(new TextEncoder().encode(text).length>limit) throw new Error('response_too_large');
    return text;
  }
  const reader=res.body.getReader();const decoder=new TextDecoder();let total=0,out='';
  try{
    while(true){
      const {done,value}=await reader.read();if(done)break;
      total+=value?.byteLength||0;if(total>limit){try{await reader.cancel();}catch{}throw new Error('response_too_large');}
      out+=decoder.decode(value,{stream:true});
    }
    out+=decoder.decode();return out;
  }finally{try{reader.releaseLock?.();}catch{}}
}

async function probeImage(raw){
  const {res,finalUrl}=await safeFetch(raw,{
    method:'GET',
    headers:{'accept':'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8','range':'bytes=0-65535'}
  },3);
  if(!res.ok&&res.status!==206) return {ok:false,status:res.status};
  const ct=(res.headers.get('content-type')||'').toLowerCase();
  if(!ct.startsWith('image/')) return {ok:false,status:res.status,contentType:ct};
  const len=Number(res.headers.get('content-length')||0);
  if(len&&len>15*1024*1024) return {ok:false,status:res.status,reason:'image_too_large'};
  return {ok:true,status:res.status,contentType:ct,finalUrl};
}
export default async(req)=>{
  if(req.method!=='POST') return json({error:'method_not_allowed'},405);
  let body; try{body=await req.json();}catch{return json({error:'invalid_json'},400);}
  const rawUrl=String(body?.url||'').trim();
  const entityName=String(body?.name||'').trim();
  if(!rawUrl) return json({error:'url_required'},400);
  if(rawUrl.length>2048||entityName.length>160) return json({error:'input_too_long'},400);

  try{
    const {res,finalUrl}=await safeFetch(rawUrl,{
      method:'GET',headers:{'accept':'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'}
    },4);
    if(!res.ok) return json({ok:false,reason:'source_http_error',status:res.status});
    const ct=(res.headers.get('content-type')||'').toLowerCase();
    if(!ct.includes('text/html')&&!ct.includes('application/xhtml+xml'))
      return json({ok:false,reason:'source_not_html',contentType:ct});

    const html=await readTextLimited(res,1_500_000);
    const title=pageTitle(html);
    const description=pageDescription(html);
    let evidenceText=evidenceTextFromHtml(html);
    const similarity=entityName?titleSimilarity(entityName,title):0;
    const a=normalizeText(entityName),b=normalizeText(title),body=normalizeText(identityTextFromHtml(html));
    const titleVerified=!!entityName && (similarity>=0.46 || (a&&b&&(a.includes(b)||b.includes(a))));
    const bodyVerified=!!entityName && !!a && body.includes(a);
    const evidenceVerified=titleVerified||bodyVerified;
    if(evidenceVerified){
      const related=await collectRelatedEvidence(html,finalUrl,6);
      if(related) evidenceText=[evidenceText,related].filter(Boolean).join('。').slice(0,32000);
    }
    if(entityName&&!evidenceVerified)
      return json({ok:false,reason:'identity_mismatch',pageTitle:title,pageDescription:description,evidenceText,titleVerified:false,bodyVerified:false,evidenceVerified:false,titleSimilarity:Number(similarity.toFixed(3)),finalUrl});

    let image=imageFromHtml(html);
    if(!image)
      return json({ok:false,reason:'no_metadata_image',pageTitle:title,pageDescription:description,evidenceText,titleVerified,bodyVerified,evidenceVerified:true,titleSimilarity:Number(similarity.toFixed(3)),finalUrl});

    image=new URL(image,finalUrl).toString();
    const probe=await probeImage(image);
    if(!probe.ok)
      return json({ok:false,reason:'image_probe_failed',probe,pageTitle:title,pageDescription:description,evidenceText,titleVerified,bodyVerified,evidenceVerified:true,titleSimilarity:Number(similarity.toFixed(3)),finalUrl});

    return json({
      ok:true,source:'metadata',imageUrl:probe.finalUrl||image,
      pageTitle:title,pageDescription:description,evidenceText,titleVerified,bodyVerified,evidenceVerified:true,titleSimilarity:Number(similarity.toFixed(3)),
      imageProbe:true,finalUrl
    });
  }catch(err){
    return json({ok:false,reason:String(err?.message||'source_cover_error')});
  }
};
export const __test={normalizeText,dice,titleSimilarity,pageTitle,pageDescription,identityTextFromHtml,evidenceTextFromHtml,relatedEvidenceLinks,imageFromHtml,normalizeHost,mappedIPv4FromIPv6,isBlockedIP,isBlockedHostLiteral};
export const config={path:'/api/source-cover',rateLimit:{windowLimit:30,windowSize:60,aggregateBy:['ip','domain']}};
