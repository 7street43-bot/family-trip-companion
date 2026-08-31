function getApiKey() {
  return process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
}

const TYPE_HINTS = {
  attraction: new Set([
    'tourist_attraction','amusement_park','aquarium','zoo','museum','park',
    'visitor_center','cultural_landmark','historical_landmark','playground',
    'wildlife_park','national_park'
  ]),
  hotel: new Set([
    'hotel','lodging','resort_hotel','bed_and_breakfast','motel','hostel',
    'guest_house','campground'
  ]),
  restaurant: new Set([
    'restaurant','cafe','bakery','meal_takeaway','food_court','coffee_shop',
    'brunch_restaurant','chinese_restaurant','taiwanese_restaurant'
  ]),
  activity: new Set([
    'tourist_attraction','amusement_center','playground','sports_activity_location',
    'children_amusement_center'
  ])
};

const QUERY_HINT = {
  attraction: '景點',
  hotel: '住宿',
  restaurant: '餐廳',
  activity: '親子活動'
};

function json(body, status=200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function norm(s='') {
  return String(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/臺/g,'台')
    .replace(/[\s\-—–_·・,，.。:：()（）【】\[\]\/\\'"]/g,'')
    .trim();
}

function coreName(s='') {
  return norm(s)
    .replace(/股份有限公司|有限公司|有限責任公司|官方網站|官方粉絲團|官方/g,'')
    .replace(/旗艦店|官方店/g,'');
}

function bigrams(s='') {
  const n = coreName(s);
  if (!n) return [];
  if (n.length === 1) return [n];
  const out = [];
  for (let i=0;i<n.length-1;i++) out.push(n.slice(i,i+2));
  return out;
}

function dice(a='', b='') {
  const A=bigrams(a), B=bigrams(b);
  if (!A.length || !B.length) return 0;
  const counts=new Map();
  for (const x of A) counts.set(x,(counts.get(x)||0)+1);
  let hits=0;
  for (const y of B) {
    const c=counts.get(y)||0;
    if(c){hits++; counts.set(y,c-1);}
  }
  return (2*hits)/(A.length+B.length);
}

function nameSimilarity(a='', b='') {
  const x=coreName(a), y=coreName(b);
  if (!x || !y) return 0;
  if (x===y) return 1;
  if (x.includes(y) || y.includes(x)) {
    const ratio=Math.min(x.length,y.length)/Math.max(x.length,y.length);
    return Math.max(0.84, Math.min(0.99, 0.80 + ratio*0.19));
  }
  return dice(x,y);
}

function locationTokens(s='') {
  const raw=String(s)
    .normalize('NFKC')
    .replace(/臺/g,'台')
    .replace(/[\-—–_·・,，.。()（）【】\[\]\/\\]+/g,' ');
  const parts=raw.split(/\s+/).map(x=>x.trim()).filter(Boolean);
  const extra=[];
  for(const t of parts){
    if(t.length>=2) extra.push(t);
    const noSuffix=t.replace(/(縣|市|區|鄉|鎮|村|里)$/,'');
    if(noSuffix.length>=2 && noSuffix!==t) extra.push(noSuffix);
  }
  return [...new Set(extra.map(norm).filter(x=>x.length>=2))];
}

function isTaiwanAddress(addr='') {
  const a=String(addr).replace(/臺/g,'台');
  return /(台灣|Taiwan|台北|新北|桃園|新竹|苗栗|台中|彰化|南投|雲林|嘉義|台南|高雄|屏東|宜蘭|花蓮|台東|澎湖|金門|連江)/i.test(a);
}

function scorePlace(place, targetName, location, entityType) {
  const display=place?.displayName?.text || '';
  const addr=String(place?.formattedAddress || '');
  const addrN=norm(addr);
  const similarity=nameSimilarity(display,targetName);
  const exactName=coreName(display)===coreName(targetName);

  const tokens=locationTokens(location);
  const matchedTokens=tokens.filter(t=>addrN.includes(t));
  const locationMatch=matchedTokens.length>0;
  const meaningfulLocation=tokens.length>0;

  const typeSet=TYPE_HINTS[entityType] || new Set();
  const typeMatch=typeSet.has(place?.primaryType || '');
  const hasPhoto=Array.isArray(place?.photos) && place.photos.length>0;
  const taiwan=isTaiwanAddress(addr);

  let score=Math.round(similarity*72);
  if(locationMatch) score+=Math.min(22,10+matchedTokens.length*5);
  if(typeMatch) score+=9;
  if(taiwan) score+=5;
  if(hasPhoto) score+=3;

  return {
    score, similarity, exactName, locationMatch, meaningfulLocation,
    matchedTokens, typeMatch, hasPhoto, taiwan
  };
}

async function googleTextSearch(apiKey, textQuery, fieldMask) {
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),12000);
  let upstream;
  try{
    upstream=await fetch('https://places.googleapis.com/v1/places:searchText',{
      method:'POST',signal:ctrl.signal,
      headers:{
        'content-type':'application/json',
        'X-Goog-Api-Key':apiKey,
        'X-Goog-FieldMask':fieldMask
      },
      body:JSON.stringify({textQuery,languageCode:'zh-TW',regionCode:'TW'})
    });
  }finally{clearTimeout(timer);}

  if(!upstream.ok){
    const text=await upstream.text();
    console.error('[place-search] Google Places upstream error',{
      status:upstream.status, query:textQuery, detail:text.slice(0,1200)
    });
    const err=new Error('google_places_error');
    err.status=upstream.status;
    err.detail=text.slice(0,1200);
    throw err;
  }
  return upstream.json();
}

function extractAdmin(place={}){
  const components=Array.isArray(place.addressComponents)?place.addressComponents:[];
  const byType=(type)=>components.find(c=>Array.isArray(c.types)&&c.types.includes(type));
  const rawCounty=byType('administrative_area_level_1')?.longText || byType('locality')?.longText || '';
  const rawDistrict=byType('sublocality_level_1')?.longText || byType('administrative_area_level_2')?.longText || '';
  const a=String(place.formattedAddress||'').replace(/臺/g,'台');
  const cm=a.match(/(基隆市|台北市|新北市|桃園市|新竹市|新竹縣|宜蘭縣|苗栗縣|台中市|彰化縣|南投縣|雲林縣|嘉義市|嘉義縣|台南市|高雄市|屏東縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)/);
  let county=String(rawCounty||'').replace(/臺/g,'台');
  if(!/(縣|市)$/.test(county) || county==='台灣') county=cm?.[1]||'';
  let district=String(rawDistrict||'').replace(/臺/g,'台');
  if(!/(區|鄉|鎮|市)$/.test(district) && county){
    const after=a.slice(a.indexOf(county)+county.length); const dm=after.match(/^([^0-9\s]{1,8}(?:區|鄉|鎮|市))/); if(dm) district=dm[1];
  }
  return {county,district};
}

function mapCandidate(place,name,location,entityType,queryRank=0){
  const scored=scorePlace(place,name,location,entityType);
  const admin=extractAdmin(place);
  return {
    placeId:place.id,
    displayName:place?.displayName?.text || '',
    formattedAddress:place.formattedAddress || '',
    county:admin.county,
    district:admin.district,
    latitude:place?.location?.latitude ?? null,
    longitude:place?.location?.longitude ?? null,
    googleMapsUrl:place.googleMapsUri || '',
    primaryType:place.primaryType || '',
    primaryTypeLabel:place?.primaryTypeDisplayName?.text || '',
    types:Array.isArray(place.types)?place.types:[],
    accessibilityOptions:place.accessibilityOptions || null,
    openingDate:place.openingDate || null,
    websiteUri:place.websiteUri || '',
    hasPhoto:scored.hasPhoto,
    score:scored.score,
    similarity:Number(scored.similarity.toFixed(3)),
    exactName:scored.exactName,
    locationMatch:scored.locationMatch,
    matchedTokens:scored.matchedTokens,
    typeMatch:scored.typeMatch,
    taiwan:scored.taiwan,
    queryRank
  };
}

function decideAuto(candidates, {locationProvided=false, branchRisk=false}={}) {
  if(!candidates.length) return {candidate:null,reason:'no_candidates'};
  const top=candidates[0], second=candidates[1];
  const scoreGap=top.score-(second?.score ?? 0);
  const simGap=top.similarity-(second?.similarity ?? 0);
  const secondStrong=(second?.similarity ?? 0) >= 0.88;

  if(!top.taiwan) return {candidate:null,reason:'top_not_taiwan'};

  if(branchRisk){
    if(top.locationMatch && top.similarity>=0.86 && (top.typeMatch || top.exactName) &&
       scoreGap>=7 && (!secondStrong || simGap>=0.05)){
      return {candidate:{...top,autoMatch:true,confidence:'high',matchReason:'branch-resolved-by-location'},reason:'branch_resolved'};
    }
    return {candidate:null,reason:'branch_needs_confirmation'};
  }

  if(top.locationMatch && top.similarity>=0.88 && (top.typeMatch || top.exactName) &&
     scoreGap>=5 && (!secondStrong || simGap>=0.035)){
    return {candidate:{...top,autoMatch:true,confidence:'high',matchReason:'name+location+margin'},reason:'name_location_margin'};
  }

  if(top.exactName && top.similarity>=0.99 && scoreGap>=13 &&
     ((second?.similarity ?? 0)<=0.84 || simGap>=0.12)){
    return {candidate:{...top,autoMatch:true,confidence:'high',matchReason:locationProvided?'unique-exact-name; city soft':'unique-exact-name'},reason:'unique_exact'};
  }

  if(top.similarity>=0.93 && top.typeMatch && scoreGap>=14 &&
     ((second?.similarity ?? 0)<=0.82 || simGap>=0.11)){
    return {candidate:{...top,autoMatch:true,confidence:'medium-high',matchReason:'unique-near-name+type'},reason:'unique_near'};
  }

  if(top.similarity>=0.96 && scoreGap>=18 && (second?.similarity ?? 0)<0.80){
    return {candidate:{...top,autoMatch:true,confidence:'medium-high',matchReason:'dominant-name'},reason:'dominant_name'};
  }

  return {candidate:null,reason:'needs_confirmation'};
}

export default async (req) => {
  if(req.method!=='POST') return json({error:'method_not_allowed'},405);
  const apiKey=getApiKey();
  if(!apiKey) return json({
    error:'not_configured',
    message:'GOOGLE_PLACES_API_KEY 尚未設定（亦支援舊名 GOOGLE_MAPS_API_KEY）'
  },503);

  let body;
  try{body=await req.json();}
  catch{return json({error:'invalid_json'},400);}

  const name=String(body?.name||'').trim();
  const location=String(body?.location||'').trim();
  const entityType=String(body?.entityType||'attraction').trim();
  const branchRisk=!!body?.branchRisk;
  if(!name) return json({error:'name_required'},400);
  if(name.length>120 || location.length>120) return json({error:'input_too_long'},400);

  const fieldMask=[
    'places.id','places.displayName','places.formattedAddress','places.addressComponents','places.location',
    'places.googleMapsUri','places.photos','places.primaryType','places.primaryTypeDisplayName',
    'places.types','places.accessibilityOptions','places.openingDate'
  ].join(',');

  const queries=[];
  const merge=new Map();

  async function runQuery(q){
    if(!q || queries.includes(q)) return;
    queries.push(q);
    const result=await googleTextSearch(apiKey,q,fieldMask);
    for(const p of (result.places||[]).slice(0,10)) if(!merge.has(p.id)) merge.set(p.id,p);
  }

  try {
    await runQuery([name,location,'台灣'].filter(Boolean).join(' '));

    let candidates=[...merge.values()]
      .map((p,i)=>mapCandidate(p,name,location,entityType,i))
      .sort((a,b)=>b.score-a.score);

    let decision=decideAuto(candidates,{locationProvided:!!location,branchRisk});

    if(!decision.candidate){
      await runQuery([name,'台灣'].join(' '));
      candidates=[...merge.values()]
        .map((p,i)=>mapCandidate(p,name,location,entityType,i))
        .sort((a,b)=>b.score-a.score);
      decision=decideAuto(candidates,{locationProvided:!!location,branchRisk});
    }

    if(!decision.candidate && QUERY_HINT[entityType] &&
       (!candidates.length || (candidates[0]?.similarity ?? 0)<0.83)){
      await runQuery([name,QUERY_HINT[entityType],'台灣'].join(' '));
      candidates=[...merge.values()]
        .map((p,i)=>mapCandidate(p,name,location,entityType,i))
        .sort((a,b)=>b.score-a.score);
      decision=decideAuto(candidates,{locationProvided:!!location,branchRisk});
    }

    return json({
      query:queries[0]||'',
      queriesTried:queries,
      branchRisk,
      autoCandidate:decision.candidate || null,
      decisionReason:decision.reason,
      candidates:candidates.slice(0,6)
    });
  } catch(err){
    return json({error:'google_places_error',status:err.status||502,detail:err.detail||''},502);
  }
};

export const __test = { norm, coreName, nameSimilarity, locationTokens, scorePlace, extractAdmin, mapCandidate, decideAuto };
export const config={path:'/api/place-search',rateLimit:{windowLimit:30,windowSize:60,aggregateBy:['ip','domain']}};
