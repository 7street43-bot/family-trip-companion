const AUTH_SERVER = String(process.env.SUPABASE_URL || 'https://iaecgwitsxghsovdkotw.supabase.co').replace(/\/$/,'') + '/auth/v1';

export default async function handler(req) {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({error:'method_not_allowed'}), {
      status:405,
      headers:{'content-type':'application/json; charset=utf-8','allow':'GET','cache-control':'no-store'}
    });
  }
  const origin = new URL(req.url).origin;
  return new Response(JSON.stringify({
    resource:`${origin}/api/journal-mcp`,
    authorization_servers:[AUTH_SERVER],
    scopes_supported:['email','profile'],
    bearer_methods_supported:['header'],
    resource_name:'雙寶出遊趣｜旅遊日誌'
  }), {
    status:200,
    headers:{
      'content-type':'application/json; charset=utf-8',
      'cache-control':'public, max-age=300',
      'access-control-allow-origin':'*',
      'x-content-type-options':'nosniff'
    }
  });
}

export const config = { path:'/.well-known/oauth-protected-resource' };
