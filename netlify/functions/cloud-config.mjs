const DEFAULT_URL = 'https://iaecgwitsxghsovdkotw.supabase.co';
const DEFAULT_PUBLISHABLE_KEY = 'sb_publishable_6der9Hrl7J1KLrrzuXCdKQ_yl-IpYRe';
const DEFAULT_SITE_ORIGIN = 'https://comfy-heliotrope-475c71.netlify.app';

export default async () => {
  const url = String(process.env.SUPABASE_URL || DEFAULT_URL).trim();
  const publishableKey = String(process.env.SUPABASE_PUBLISHABLE_KEY || DEFAULT_PUBLISHABLE_KEY).trim();
  const siteOrigin = String(process.env.APP_SITE_URL || DEFAULT_SITE_ORIGIN).trim().replace(/\/$/, '');
  const siteOriginValid = /^https:\/\/[^/]+$/i.test(siteOrigin);
  const configured = /^https:\/\/.+\.supabase\.co$/i.test(url) && /^sb_publishable_/i.test(publishableKey);
  return Response.json(
    { configured, url: configured ? url : '', publishableKey: configured ? publishableKey : '', siteOrigin: siteOriginValid ? siteOrigin : '' },
    { headers: { 'cache-control':'no-store', 'x-content-type-options':'nosniff' } }
  );
};
export const config = { path:'/api/cloud-config' };
