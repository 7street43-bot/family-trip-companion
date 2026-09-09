export const FALLBACK_DURATION_MINUTES = 90;

function clean(value = '') {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase();
}

function finiteDuration(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(1440, Math.round(n));
}

function has(text, pattern) {
  return pattern.test(text);
}

export function suggestStopDurationMinutes(input = {}) {
  const explicit = finiteDuration(input.plannedDurationMinutes ?? input.durationMinutes);
  if (explicit !== null) return explicit;

  const title = clean(input.title);
  const primaryType = clean(input.primaryType);
  const type = clean(input.entityType);
  const text = `${title} ${primaryType}`;

  // Food stops: distinguish a quick café/dessert stop from a full meal.
  if (has(text, /(咖啡|cafe|coffee|甜點|dessert|冰品|冰店|麵包|bakery|茶屋|茶館)/)) return 60;
  if (has(text, /(火鍋|燒肉|buffet|吃到飽|牛排|steak|居酒屋|餐廳|restaurant|food)/) || type === 'restaurant') {
    return has(text, /(火鍋|燒肉|buffet|吃到飽|居酒屋)/) ? 90 : 75;
  }

  // Large destinations need substantially more time than a generic stop.
  if (has(text, /(主題樂園|遊樂園|樂園|動物園|zoo|水族館|aquarium|海生館|博物館|museum|美術館|科學館|科博館|兒童館|探索館|大型園區)/)) return 180;
  if (has(text, /(步道|登山|健行|hiking|trail|森林|國家公園|遊憩區|風景區|瀑布)/)) return 150;
  if (has(text, /(農場|牧場|觀光工廠|體驗館|手作|diy|工坊|採果|農園)/)) return 120;
  if (has(text, /(親子館|公園|playground|遊戲場|沙灘|海灘|海邊|老街|夜市|市場|百貨|商場|mall|outlet)/)) return 90;
  if (has(text, /(寺|廟|神社|教堂|church|觀景|展望|燈塔|拍照|打卡|紀念碑)/)) return 45;

  if (type === 'activity') return 120;
  // Lodging as an itinerary stop means check-in / settle-in time, not overnight stay.
  if (type === 'hotel' || has(text, /(飯店|旅館|民宿|hotel|resort|motel|hostel)/)) return 30;
  if (type === 'attraction') return FALLBACK_DURATION_MINUTES;

  return FALLBACK_DURATION_MINUTES;
}

export function suggestionReason(input = {}) {
  const minutes = suggestStopDurationMinutes(input);
  const type = clean(input.entityType);
  if (type === 'restaurant') return `依餐飲類型建議 ${minutes} 分`;
  if (type === 'hotel') return `依住宿停靠建議 ${minutes} 分`;
  if (type === 'activity') return `依活動類型建議 ${minutes} 分`;
  return `依景點類型建議 ${minutes} 分`;
}
