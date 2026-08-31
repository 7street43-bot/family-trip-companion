export default async () => {
  const configured = !!(process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY);
  return Response.json({ configured }, { headers:{'cache-control':'no-store'} });
};
export const config = { path:'/api/place-health' };
