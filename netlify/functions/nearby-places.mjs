function getApiKey(){return process.env.GOOGLE_PLACES_API_KEY||process.env.GOOGLE_MAPS_API_KEY||'';}
function json(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});}
const TYPE_SETS={
  attraction:['tourist_attraction','museum','aquarium','zoo','amusement_park','park','playground','shopping_mall'],
  activity:['tourist_attraction','museum','aquarium','zoo','amusement_park','park','playground','shopping_mall'],
  restaurant:['restaurant','cafe','bakery'],
  hotel:['hotel','resort_hotel','motel','hostel','bed_and_breakfast','guest_house','campground']
};
function validCoord(v,min,max){const n=Number(v);return Number.isFinite(n)&&n>=min&&n<=max?n:null;}
function haversineKm(a,b){const R=6371,toRad=x=>x*Math.PI/180,dLat=toRad(b.lat-a.lat),dLon=toRad(b.lng-a.lng),x=Math.sin(dLat/2)**2+Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(x));}
function parseTaiwanAdmin(address=''){const a=String(address||'').replace(/臺/g,'台');const county=(a.match(/(台北市|新北市|桃園市|台中市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)/)||[])[1]||'';const rest=county?a.slice(a.indexOf(county)+county.length):a;const district=(rest.match(/^([^路街巷弄號段]{1,8}(?:區|鄉|鎮|市))/)||[])[1]||'';return {county,district};}
function mapPlace(p,center,source){const lat=p?.location?.latitude,lng=p?.location?.longitude,formattedAddress=String(p.formattedAddress||''),admin=parseTaiwanAdmin(formattedAddress);return {placeId:String(p.id||''),displayName:String(p?.displayName?.text||''),formattedAddress,county:admin.county,district:admin.district,latitude:Number.isFinite(lat)?lat:null,longitude:Number.isFinite(lng)?lng:null,googleMapsUrl:String(p.googleMapsUri||''),primaryType:String(p.primaryType||''),primaryTypeLabel:String(p?.primaryTypeDisplayName?.text||''),types:Array.isArray(p.types)?p.types:[],hasPhoto:Array.isArray(p.photos)&&p.photos.length>0,distanceKm:Number.isFinite(lat)&&Number.isFinite(lng)?Number(haversineKm(center,{lat,lng}).toFixed(2)):null,source};}
async function googlePost(apiKey,url,body,fieldMask){const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),12000);try{const r=await fetch(url,{method:'POST',signal:ctrl.signal,headers:{'content-type':'application/json','X-Goog-Api-Key':apiKey,'X-Goog-FieldMask':fieldMask},body:JSON.stringify(body)});let data={};try{data=await r.json();}catch{}if(!r.ok){console.error('[nearby-places] upstream',{status:r.status,detail:JSON.stringify(data).slice(0,1000)});return {ok:false,status:r.status,data};}return {ok:true,status:r.status,data};}catch(err){return {ok:false,status:502,data:{error:err?.name==='AbortError'?'timeout':'fetch_failed'}};}finally{clearTimeout(timer);}}
export default async(req)=>{
  if(req.method!=='POST')return json({error:'method_not_allowed'},405);
  const apiKey=getApiKey();if(!apiKey)return json({error:'not_configured'},503);
  let body={};try{body=await req.json();}catch{return json({error:'invalid_json'},400);}
  const latitude=validCoord(body.latitude,-90,90),longitude=validCoord(body.longitude,-180,180);if(latitude===null||longitude===null)return json({error:'invalid_coordinates'},400);
  const entityType=['attraction','activity','restaurant','hotel'].includes(body.entityType)?body.entityType:'attraction';
  const mode=body.mode==='text'?'text':'nearby';const radiusKm=Math.max(.5,Math.min(50,Number(body.radiusKm)||15));const center={lat:latitude,lng:longitude};
  const fieldMask=['places.id','places.displayName','places.formattedAddress','places.location','places.googleMapsUri','places.primaryType','places.primaryTypeDisplayName','places.types','places.photos'].join(',');
  let upstream;
  if(mode==='nearby'){
    upstream=await googlePost(apiKey,'https://places.googleapis.com/v1/places:searchNearby',{includedTypes:TYPE_SETS[entityType],maxResultCount:10,rankPreference:'POPULARITY',languageCode:'zh-TW',regionCode:'TW',locationRestriction:{circle:{center:{latitude,longitude},radius:radiusKm*1000}}},fieldMask);
  }else{
    const query=String(body.query||'').trim().slice(0,80);if(!query)return json({error:'query_required'},400);
    upstream=await googlePost(apiKey,'https://places.googleapis.com/v1/places:searchText',{textQuery:query,languageCode:'zh-TW',regionCode:'TW',pageSize:10,locationBias:{circle:{center:{latitude,longitude},radius:Math.min(50000,radiusKm*1000)}}},fieldMask);
  }
  if(!upstream.ok)return json({error:'google_places_error',status:upstream.status,detail:upstream.data},502);
  const candidates=(upstream.data?.places||[]).map(p=>mapPlace(p,center,mode==='nearby'?'google-nearby':'google-text')).filter(x=>x.placeId&&x.displayName).sort((a,b)=>(a.distanceKm??9999)-(b.distanceKm??9999)).slice(0,10);
  return json({mode,entityType,radiusKm,candidates});
};
export const __test={TYPE_SETS,validCoord,haversineKm,parseTaiwanAdmin,mapPlace};
export const config={path:'/api/nearby-places',rateLimit:{windowLimit:20,windowSize:60,aggregateBy:['ip','domain']}};
