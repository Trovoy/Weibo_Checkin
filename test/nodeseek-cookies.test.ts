import test from 'node:test';
import assert from 'node:assert/strict';
import { NODESEEK_ORIGINS, NODESEEK_COOKIE_PERMISSIONS, hasLoginCookie, readNodeSeekCookies, cookieHeader, diagnosticText } from '../extension/cookies.js';
const cookie = (extra = {}) => ({ name: 'session', value: 'SECRET_NEVER_DIAGNOSE', domain: '.nodeseek.com', path: '/', httpOnly: true, ...extra });
function api(overrides = {}) {
  return { permissions: { contains: async()=>true }, tabs:{query:async()=>[]}, cookies:{getAllCookieStores:async()=>[],getAll:async()=>[]}, ...overrides };
}
test('both apex and www permissions are required before reading the cookie jar',async()=>{
  const checked=[];
  const result=await readNodeSeekCookies(api({permissions:{contains:async({origins})=>{checked.push(origins[0]);return origins[0].includes('www.')}},cookies:{getAll:()=>assert.fail('ungranted root cookie access')}}));
  assert.deepEqual(checked,NODESEEK_COOKIE_PERMISSIONS);assert.deepEqual(result.diagnostic.permissions,[false,true,false,true]);assert.deepEqual(result.cookies,[]);
});
test('reads the logged-in tab store without merging other accounts and preserves HttpOnly root cookies',async()=>{
  const result=await readNodeSeekCookies(api({tabs:{query:async()=>[{id:2,active:true},{id:1,active:false}]},cookies:{
    getAllCookieStores:async()=>[{id:'regular',tabIds:[1]},{id:'private',tabIds:[2]}],
    getAll:async details=>{assert.equal(details.storeId,'private');assert.equal(details.url,'https://www.nodeseek.com/api/attendance');return [cookie()]}
  }}));
  assert.equal(cookieHeader(result.cookies),'session=SECRET_NEVER_DIAGNOSE');assert.equal(result.diagnostic.selectedStore,true);
  const text=diagnosticText(result.diagnostic,'4.0.3');assert.match(text,/接口 Cookie：1/);assert.equal(text.includes('SECRET'),false);assert.equal(text.includes('session'),false);
});
test('empty URL result reports domain-only counts but never sends path-incompatible credentials',async()=>{
  const result=await readNodeSeekCookies(api({cookies:{getAllCookieStores:async()=>[],getAll:async details=>details.domain?[cookie({path:'/other'}),cookie({domain:'unrelated.nodeseek.com'})]:[]}}));
  assert.equal(result.diagnostic.urlCookies,0);assert.equal(result.diagnostic.domainCookies,1);assert.equal(cookieHeader(result.cookies),'');
  assert.equal(JSON.stringify(result.diagnostic).includes('SECRET'),false);
});
test('includes first-party partition cookies and excludes a different top-level site',async()=>{
  for(const topLevelSite of ['https://nodeseek.com','https://unrelated.example']){
    let partitionReads=0;
    const result=await readNodeSeekCookies(api({tabs:{query:async()=>[{id:7,active:true}]},cookies:{getAllCookieStores:async()=>[{id:'regular',tabIds:[7]}],getPartitionKey:async()=>({partitionKey:{topLevelSite,hasCrossSiteAncestor:false}}),getAll:async details=>{if(details.partitionKey){partitionReads++;return [cookie({partitionKey:details.partitionKey})]}return []}}}));
    assert.equal(partitionReads,topLevelSite==='https://nodeseek.com'?1:0);
    assert.equal(result.cookies.length,partitionReads);
  }
});
test('a closed tab or older partition API still allows ordinary cookie sync',async()=>{
  const result=await readNodeSeekCookies(api({tabs:{query:async()=>[{id:7,active:true}]},cookies:{getAllCookieStores:async()=>[],getPartitionKey:async()=>{throw Error('tab closed')},getAll:async()=>[cookie()]}}));
  assert.equal(result.cookies.length,1);assert.equal(result.diagnostic.urlCookies,1);
});

test('HTTP cookie access is required for non-Secure pjwt even when querying an HTTPS URL',async()=>{
  for(const allowHttp of [false,true]){
    const permitted = origin => allowHttp || !origin.startsWith('http://');
    const result=await readNodeSeekCookies(api({permissions:{contains:async({origins})=>origins.every(permitted)},cookies:{getAllCookieStores:async()=>[],getAll:async()=>[cookie({name:'cf_clearance',secure:true}),cookie({name:'pjwt',secure:false})]}}));
    assert.equal(hasLoginCookie(result.cookies),allowHttp);
    if(allowHttp){assert.equal(result.diagnostic.loginCookie,true);assert.equal(result.diagnostic.nonSecureCookies,1)}
  }
  assert.equal(hasLoginCookie([cookie({name:'cf_clearance'})]),false);
  assert.equal(hasLoginCookie([cookie({name:'pjwt'})]),true);
});
