let recentDate = '', recentRecords = [], recentMonths = new Set(), recentErrors = false, recentPending;
function getOverviewHistory() {
  const daily = state?.recentCompletions || [], loaded = recentDate === state?.today;
  const huyaAvailable = platformRegistry.some(p => p.id === 'huya' && p.available);
  const huyaLoaded = typeof hySnapshot !== 'undefined' && !!hySnapshot && hySnapshot.date === state?.today;
  const huyaFailed = typeof hyError !== 'undefined' && !!hyError;
  const pending = !platformRegistry.length || daily.length !== 7 || (nsAvailable() && (!loaded || !!recentPending)) || (huyaAvailable && !huyaLoaded && !huyaFailed);
  const partial = (nsAvailable() && loaded && recentErrors) || (huyaAvailable && huyaFailed);
  return { pending, partial, series: overviewHistory(daily, loaded ? recentRecords : [], huyaLoaded && !huyaFailed ? hySnapshot.history : [], {
    nodeseek: nsAvailable(), months: loaded ? recentMonths : new Set(), huya: huyaAvailable, huyaLoaded: huyaLoaded && !huyaFailed
  }) };
}
function resetOverview() {
  recentDate = ''; recentRecords = []; recentMonths = new Set(); recentErrors = false; recentPending = undefined;
  if (typeof overviewView !== 'undefined') overviewView.reset();
}
function renderOverviewStats() { if (state && typeof overviewView !== 'undefined') overviewView.render(); }
function renderRecentStats() { renderOverviewStats(); }
async function loadRecentStats(force = false) {
  if (!state || !nsAvailable()) { renderRecentStats(); return; }
  const today = state.today, epoch = platformEpoch;
  if (recentPending?.date === today) return recentPending.promise;
  if (!force && recentDate === today && !recentErrors) return;
  const months = [...new Set((state.recentCompletions || []).map(day => day.date.slice(0, 7)))];
  if (!months.length) return;
  const pending = (async () => {
    const results = await Promise.allSettled(months.map(month => api('platforms/nodeseek/history?month=' + month)));
    if (epoch !== platformEpoch || state?.today !== today) return;
    recentRecords = []; recentMonths = new Set(); recentErrors = false;
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') { recentMonths.add(months[index]); recentRecords.push(...result.value.records); }
      else recentErrors = true;
    });
    recentDate = today;
  })();
  recentPending = { date: today, promise: pending }; renderRecentStats();
  try { await pending; }
  finally { if (recentPending?.promise === pending) recentPending = undefined; if (epoch === platformEpoch) renderRecentStats(); }
}
