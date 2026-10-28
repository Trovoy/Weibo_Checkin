// Presentation data only. Unknown responses stay distinct from confirmed zeroes.
const overviewPlatforms = [
  { id: 'weibo', name: '微博', key: 'wb' },
  { id: 'nodeseek', name: 'NodeSeek', key: 'ns' },
  { id: 'huya', name: '虎牙', key: 'hy' }
];
function overviewToday(account, registry, ns, nsFailure, hy, hyFailure) {
  return overviewPlatforms.map(platform => {
    const available = platform.id === 'weibo' || registry.some(p => p.id === platform.id && p.available);
    const result = { ...platform, available, unknown: !registry.length, total: 0, done: 0 };
    if (platform.id === 'weibo') {
      result.total = account.topics.length;
      result.done = account.topics.filter(t => account.completedToday.includes(t.id)).length;
    } else if (available) {
      const snapshot = platform.id === 'nodeseek' ? ns : hy;
      result.unknown ||= !!(platform.id === 'nodeseek' ? nsFailure : hyFailure) || !snapshot || snapshot.date !== account.today;
      if (!result.unknown) {
        result.total = snapshot.config?.configured || snapshot.configured || snapshot.record ? 1 : 0;
        result.done = platform.id === 'nodeseek'
          ? Number(!!snapshot.record?.ok && snapshot.record.date === account.today)
          : Number(snapshot.record?.code === 'SUCCESS' && snapshot.record.day === account.today);
      }
    }
    result.done = Math.min(result.total, result.done);
    return result;
  });
}
function overviewSummary(platforms, selected = 'all') {
  const items = selected === 'all' ? platforms : platforms.filter(p => p.id === selected);
  const total = items.reduce((n, p) => n + p.total, 0), done = items.reduce((n, p) => n + p.done, 0);
  const unknown = items.some(p => p.unknown);
  return { items, total, done, unknown, percent: unknown || !total ? null : Math.round(done / total * 100) };
}
function recentSeries(daily, records, huya = []) {
  const signed = new Set(records.filter(entry => entry.ok).map(entry => entry.date));
  const gifted = new Set(huya.filter(entry => entry.code === 'SUCCESS').map(entry => entry.day));
  return daily.map(day => ({ date: day.date, weibo: day.count, nodeseek: signed.has(day.date) ? 1 : 0, huya: gifted.has(day.date) ? 1 : 0 }));
}
function overviewHistory(daily, records, huya, availability) {
  return recentSeries(daily, records, huya).map(day => ({ ...day,
    nodeseek: availability.nodeseek && availability.months.has(day.date.slice(0, 7)) ? day.nodeseek : null,
    huya: availability.huya && availability.huyaLoaded ? day.huya : null
  }));
}
