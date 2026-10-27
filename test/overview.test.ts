import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/overview.js', import.meta.url), 'utf8');
function setup(api) {
  const elements = new Map();
  const node = (_tag?, text?, _class?) => ({ textContent: text, hidden:false, style:{}, children:[], attrs:{},
    append(...nodes) { this.children.push(...nodes); }, replaceChildren() { this.children = []; },
    setAttribute(key,value) { this.attrs[key] = value; }, getAttribute(key) { return this.attrs[key]; },
    addEventListener() {}, focus() {} });
  const $ = id => { if (!elements.has(id)) elements.set(id,node()); return elements.get(id); };
  const dates = ['2026-12-27','2026-12-28','2026-12-29','2026-12-30','2026-12-31','2027-01-01','2027-01-02'];
  const context = vm.createContext({ $, node, api, platformEpoch:1, motion:undefined, enter() {},
    platformRegistry:[{id:'weibo'},{id:'nodeseek'}], nsAvailable:() => true,
    state:{today:'2027-01-02',recentCompletions:dates.map(date => ({date,count:1}))} });
  vm.runInContext(source,context);
  return { $, context, run: code => vm.runInContext(code,context) };
}
test('recent chart counts distinct successful NodeSeek days, including zero reward, and excludes failures and other dates', () => {
  const { run } = setup(() => {});
  const result = run(`recentSeries([{date:'2027-01-01',count:2},{date:'2027-01-02',count:0}], [
    {date:'2027-01-01',ok:true,gain:0},{date:'2027-01-01',ok:true,gain:0},
    {date:'2027-01-02',ok:false},{date:'2027-01-03',ok:true}])`);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [
    {date:'2027-01-01',weibo:2,nodeseek:1,huya:0},{date:'2027-01-02',weibo:0,nodeseek:0,huya:0}
  ]);
});
test('recent chart loads both months independently from history filters, caches reads and refreshes on request', async () => {
  const calls = [];
  const { $, run } = setup(async path => { calls.push(path); return { records:[{date:path.endsWith('12') ? '2026-12-29' : '2027-01-01',ok:true}] }; });
  await run('loadRecentStats()');
  assert.deepEqual(calls.sort(),['platforms/nodeseek/history?month=2026-12','platforms/nodeseek/history?month=2027-01']);
  assert.equal($('recent-total').textContent,'9'); assert.equal($('recent-bars').children.length,7);
  assert.equal($('recent-badge').textContent,'含今天');
  await run('loadRecentStats()'); assert.equal(calls.length,2);
  await run('loadRecentStats(true)'); assert.equal(calls.length,4);
});
test('recent chart counts confirmed Huya deliveries by day, excluding empty, uncertain and repeated entries', () => {
  const { run } = setup(() => {});
  const result = run(`recentSeries([{date:'2027-01-01',count:0},{date:'2027-01-02',count:0}], [], [
    {day:'2027-01-01',code:'SUCCESS',count:35},{day:'2027-01-01',code:'SUCCESS',count:35},
    {day:'2027-01-02',code:'EMPTY'},{day:'2027-01-02',code:'REVIEW'}])`);
  assert.deepEqual(JSON.parse(JSON.stringify(result)).map(x => x.huya), [1, 0]);
});
test('one unavailable month is marked partial rather than zero, and retry recovers the complete count', async () => {
  let fail = true;
  const { $, run } = setup(async path => {
    if (fail && path.endsWith('12')) throw new Error('unavailable');
    return { records:[{date:path.endsWith('12') ? '2026-12-29' : '2027-01-01',ok:true}] };
  });
  await run('loadRecentStats()');
  assert.equal($('recent-total').textContent,'8'); assert.equal($('recent-badge').textContent,'部分数据');
  assert.equal($('recent-retry').hidden,false);
  assert.match($('recent-bars').children[0].getAttribute('aria-label'),/NodeSeek 待确认/);
  fail = false; await run('loadRecentStats(true)');
  assert.equal($('recent-total').textContent,'9'); assert.equal($('recent-retry').hidden,true);
});
test('locking the panel discards pending history results and clears chart data', async () => {
  const resolvers = [];
  const { $, context, run } = setup(() => new Promise(resolve => resolvers.push(resolve)));
  const pending = run('loadRecentStats()');
  context.platformEpoch++; run('resetOverview()');
  for (const resolve of resolvers) resolve({records:[{date:'2027-01-01',ok:true}]});
  await pending;
  assert.equal(run('recentDate'),''); assert.equal($('recent-bars').children.length,0);
  assert.equal($('recent-total').textContent,'—'); assert.equal($('stats-recent').hidden,true);
});
