import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = ['overview-data.js', 'overview.js'].map(file => readFileSync(new URL('../public/' + file, import.meta.url), 'utf8')).join('\n');
function setup(api = async (_path: string) => ({ records: [] })) {
  const dates = ['2026-12-27','2026-12-28','2026-12-29','2026-12-30','2026-12-31','2027-01-01','2027-01-02'];
  const context = vm.createContext({ api, platformEpoch: 1,
    platformRegistry: [{id:'weibo',available:true},{id:'nodeseek',available:true}], nsAvailable: () => true,
    state: { today:'2027-01-02', topics:[{id:'a'},{id:'b'}], completedToday:['a'], recentCompletions:dates.map(date => ({date,count:1})) } });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context), plain = code => JSON.parse(JSON.stringify(run(code)));
  return { context, run, plain };
}
test('recent counts deduplicate successful days including zero reward, excluding failures and other dates', () => {
  const { plain } = setup();
  assert.deepEqual(plain(`recentSeries([{date:'2027-01-01',count:2},{date:'2027-01-02',count:0}], [
    {date:'2027-01-01',ok:true,gain:0},{date:'2027-01-01',ok:true,gain:0},
    {date:'2027-01-02',ok:false},{date:'2027-01-03',ok:true}])`), [
    {date:'2027-01-01',weibo:2,nodeseek:1,huya:0},{date:'2027-01-02',weibo:0,nodeseek:0,huya:0}
  ]);
});
test('recent history reads both months independently, caches reads and refreshes on request', async () => {
  const calls: string[] = [];
  const { run, plain } = setup(async path => { calls.push(path); return { records:[{date:path.endsWith('12') ? '2026-12-29' : '2027-01-01',ok:true}] }; });
  await run('loadRecentStats()');
  assert.deepEqual(calls.sort(),['platforms/nodeseek/history?month=2026-12','platforms/nodeseek/history?month=2027-01']);
  const history = plain('getOverviewHistory()');
  assert.equal(history.pending, false); assert.equal(history.partial, false);
  assert.equal(history.series.reduce((n, d) => n + d.weibo + d.nodeseek, 0), 9);
  assert.ok(history.series.every(d => d.huya === null));
  await run('loadRecentStats()'); assert.equal(calls.length,2);
  await run('loadRecentStats(true)'); assert.equal(calls.length,4);
});
test('Huya counts only confirmed successful delivery days, not empty or uncertain inventory', () => {
  const { plain } = setup();
  assert.deepEqual(plain(`recentSeries([{date:'2027-01-01',count:0},{date:'2027-01-02',count:0}], [], [
    {day:'2027-01-01',code:'SUCCESS',count:35},{day:'2027-01-01',code:'SUCCESS',count:35},
    {day:'2027-01-02',code:'EMPTY'},{day:'2027-01-02',code:'REVIEW'}])`).map(x => x.huya), [1,0]);
});
test('failed month remains unknown instead of a zero dip; retry restores the missing observations', async () => {
  let fail = true;
  const { run, plain } = setup(async path => {
    if (fail && path.endsWith('12')) throw new Error('unavailable');
    return { records:[{date:path.endsWith('12') ? '2026-12-29' : '2027-01-01',ok:true}] };
  });
  await run('loadRecentStats()');
  const history = plain('getOverviewHistory()'); assert.equal(history.partial, true);
  assert.equal(history.series[0].nodeseek, null); assert.equal(history.series[5].nodeseek, 1); assert.equal(history.series[6].nodeseek, 0);
  fail = false; await run('loadRecentStats(true)');
  assert.equal(run('getOverviewHistory().partial'), false); assert.equal(run('getOverviewHistory().series[0].nodeseek'), 0);
});
test('lock and date rollover discard in-flight history responses', async () => {
  for (const change of ['platformEpoch++; resetOverview()', "state.today = '2027-01-03'"]) {
    const resolvers: ((value: unknown) => void)[] = [];
    const { run } = setup(() => new Promise(resolve => resolvers.push(resolve)) as any);
    const pending = run('loadRecentStats()'); run(change);
    for (const resolve of resolvers) resolve({records:[{date:'2027-01-01',ok:true}]});
    await pending;
    assert.equal(run('recentDate'), ''); assert.equal(run('recentRecords.length'), 0);
  }
});
test('today progress filters by platform, excludes removed topics and does not equate zero inventory with gifting', () => {
  const { plain } = setup();
  const items = `overviewToday({...state,completedToday:['a','removed']}, [...platformRegistry,{id:'huya',available:true}],
    {date:state.today,config:{configured:true},record:{date:state.today,ok:true}}, '',
    {date:state.today,configured:true,inventory:{count:0},record:{day:state.today,code:'EMPTY'}}, '')`;
  assert.deepEqual(plain(`overviewSummary(${items})`), {
    items: plain(items), total:4, done:2, unknown:false, percent:50
  });
  assert.equal(plain(`overviewSummary(${items}, 'nodeseek')`).percent,100);
  assert.equal(plain(`overviewSummary(${items}, 'huya')`).percent,0);
});
test('unread or stale platform snapshots suppress percentages while preserving confirmed Weibo counts', () => {
  const { plain } = setup();
  for (const snapshot of ['undefined', "{date:'2027-01-01',config:{configured:true},record:{date:'2027-01-01',ok:true}}"] ) {
    const result = plain(`overviewSummary(overviewToday(state,platformRegistry,${snapshot},'',undefined,''))`);
    assert.equal(result.percent,null); assert.equal(result.unknown,true); assert.equal(result.done,1);
  }
});
test('unconfigured platforms do not invent tasks and zero configured projects never becomes 100 percent', () => {
  const { plain } = setup();
  const result = plain(`overviewSummary(overviewToday({...state,topics:[],completedToday:[]},platformRegistry,{date:state.today,config:{configured:false}},'',undefined,''))`);
  assert.equal(result.total,0); assert.equal(result.done,0); assert.equal(result.percent,null); assert.equal(result.unknown,false);
});
test('previous-day successful records never complete today and pending Huya history remains unknown', () => {
  const { plain, run } = setup();
  const result = plain(`overviewSummary(overviewToday(state,[...platformRegistry,{id:'huya',available:true}],
    {date:state.today,config:{configured:true},record:{date:'2027-01-01',ok:true}},'',
    {date:state.today,configured:true,record:{day:'2027-01-01',code:'SUCCESS'}},''))`);
  assert.equal(result.done,1);
  run("platformRegistry.push({id:'huya',available:true}); var hyError='unavailable'; var hySnapshot;");
  assert.equal(run('getOverviewHistory().partial'),true);
  assert.ok(plain('getOverviewHistory().series').every(d => d.huya === null));
});
