function getApiKey(){return process.env.GOOGLE_PLACES_API_KEY||process.env.GOOGLE_MAPS_API_KEY||'';}
function json(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'private, max-age=300'}});}
export default async(req)=>{
  if(req.method!=='GET')return json({error:'method_not_allowed'},405);
  const apiKey=getApiKey();if(!apiKey)return json({error:'not_configured'},503);
  const u=new URL(req.url),placeId=String(u.searchParams.get('placeId')||'').trim();
  if(!/^[A-Za-z0-9_\-]{8,220}$/.test(placeId))return json({error:'invalid_place_id'},400);
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),10000);
  try{
    const r=await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,{
      signal:ctrl.signal,
      headers:{'X-Goog-Api-Key':apiKey,'X-Goog-FieldMask':'websiteUri'}
    });
    let data={};try{data=await r.json();}catch{}
    if(!r.ok)return json({error:'google_places_error',status:r.status},502);
    return json({placeId,websiteUri:String(data.websiteUri||'')});
  }catch(err){return json({error:err?.name==='AbortError'?'timeout':'place_details_failed'},502);}
  finally{clearTimeout(timer);}
};
export const config={path:'/api/place-details',rateLimit:{windowLimit:30,windowSize:60,aggregateBy:['ip','domain']}};
