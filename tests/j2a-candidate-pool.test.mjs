import assert from 'node:assert/strict';
import {
  normalizePlannerInput,
  candidateFromEntity,
  candidateFromExternal,
  candidateFromCustom,
  mergeCandidatePool,
  toggleSelectionOrder,
  selectedCandidates
} from '../public/itinerary-candidates-core.mjs';
import { createTrip, withCandidates, moveStop } from '../public/itinerary-v2-core.mjs';
import { __test as provider } from '../netlify/functions/itinerary-candidates.mjs';

const planner = normalizePlannerInput({
  request: '帶小孩去宜蘭一日，不想一直開車',
  location: '宜蘭',
  anchor: '斑比山丘',
  themes: '動物、室內, 親子餐廳'
});
assert.equal(planner.location, '宜蘭');
assert.deepEqual(planner.themes, ['動物', '室內', '親子餐廳']);

const plan = provider.buildQueryPlan(planner);
assert.ok(plan.queries.length >= 2, 'planner must expand a mixed request into multiple provider queries');
assert.ok(plan.queries.some(q => q.includes('斑比山丘') && q.includes('附近')), 'anchor expansion missing');
assert.ok(plan.queries.some(q => q.includes('宜蘭') && q.includes('動物')), 'theme/location expansion missing');

const saved = candidateFromEntity({ id:'e1', name:'斑比山丘', entityType:'attraction', favorite:true, county:'宜蘭縣' });
const externalSameTitle = candidateFromExternal({ placeId:'p1', title:'斑比山丘', formattedAddress:'宜蘭縣冬山鄉', rating:4.7, userRatingCount:1200 });
const external2 = candidateFromExternal({ placeId:'p2', title:'張美阿嬤農場', formattedAddress:'宜蘭縣三星鄉', rating:4.6, userRatingCount:900 });
const custom = candidateFromCustom('回程買牛舌餅', 'manual-1');

const pool = mergeCandidatePool([saved], [externalSameTitle, external2], [custom]);
assert.equal(pool.length, 4, 'different stable source ids must remain independent candidates');
assert.equal(pool.find(x => x.key === 'entity:e1')?.source, 'favorite');
assert.equal(pool.find(x => x.key === 'place:p1')?.rating, 4.7);

let order = [];
order = toggleSelectionOrder(order, 'place:p1', true);
order = toggleSelectionOrder(order, 'place:p2', true);
order = toggleSelectionOrder(order, 'custom:manual-1', true);
assert.deepEqual(selectedCandidates(pool, order).map(x => x.title), ['斑比山丘', '張美阿嬤農場', '回程買牛舌餅']);

let trip = createTrip({ date:'2026-09-12', title:'候選池測試' });
trip = withCandidates(trip, pool, order);
assert.equal(trip.stops.length, 3);
assert.deepEqual(trip.stops.map(s => s.candidateKey), order);
assert.equal(trip.stops[0].placeId, 'p1');
assert.equal(trip.stops[2].kind, 'custom');

// Reorder in the confirmed itinerary, return to candidate pool, then add one more.
// Existing manual order must win; new candidate is appended.
trip = moveStop(trip, 1, 0);
const extra = candidateFromExternal({ placeId:'p3', title:'宜蘭傳藝園區', formattedAddress:'宜蘭縣五結鄉' });
const expandedPool = mergeCandidatePool(pool, [extra]);
const expandedOrder = [...trip.stops.map(s => s.candidateKey), 'place:p3'];
const rematerialized = withCandidates(trip, expandedPool, expandedOrder);
assert.deepEqual(rematerialized.stops.map(s => s.title), ['張美阿嬤農場', '斑比山丘', '回程買牛舌餅', '宜蘭傳藝園區']);

// Deselect an existing candidate: it must disappear without disturbing remaining order.
const deselected = withCandidates(rematerialized, expandedPool, expandedOrder.filter(k => k !== 'place:p1'));
assert.deepEqual(deselected.stops.map(s => s.title), ['張美阿嬤農場', '回程買牛舌餅', '宜蘭傳藝園區']);

const mergedProvider = provider.mergeResults([
  [provider.mapCandidate({ id:'g1', displayName:{text:'A'}, formattedAddress:'宜蘭縣', rating:4.2, userRatingCount:20, businessStatus:'OPERATIONAL' }, 'q1', 0, 0)],
  [provider.mapCandidate({ id:'g1', displayName:{text:'A'}, formattedAddress:'宜蘭縣', rating:4.5, userRatingCount:200, businessStatus:'OPERATIONAL' }, 'q2', 1, 0),
   provider.mapCandidate({ id:'g2', displayName:{text:'B'}, formattedAddress:'宜蘭縣', rating:4.1, userRatingCount:10 }, 'q2', 1, 1)]
], 10);
assert.equal(mergedProvider.length, 2, 'provider must dedupe Google place id across expanded queries');
assert.equal(mergedProvider.find(x => x.placeId === 'g1').matchedQueries.length, 2);

console.log('J2A CANDIDATE POOL + PROVIDER CONTRACT = PASS');
