#!/usr/bin/env python3
"""Descriptive analysis of the fixed paired synthetic benchmark; no population claims."""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import statistics


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('results',type=Path)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    data=json.loads(args.results.read_text())
    records=data['records'];manifest=next(r for r in records if r['type']=='manifest')
    arms=[r for r in records if r['type']=='arm'];pairs=defaultdict(dict)
    for row in arms:pairs[row['case']][row['arm']]=row
    if not any(r['type']=='complete' for r in records) or len(pairs)!=12 or any(set(pair)!= {'baseline','jev'} or any(row.get('error') for row in pair.values()) for pair in pairs.values()):
        raise SystemExit('Incomplete paired observations: cost comparison is blocked; raw checkpoints retained.')
    rates=data['pricing'];llm=rates['openai/gpt-5.6-luna'];jev=rates['typesafe-ai/jev']
    if manifest['model'] not in ['gpt-5.6-luna','openai/gpt-5.6-luna']:
        raise SystemExit('Model differs from snapshotted pricing; refresh matching rates first.')
    for row in arms:
        g=row['generation'];evals=row['evaluation'];responses=[e['response'] for e in evals if e.get('response')]
        evaluation_cost=sum(r['usage']['input_tokens']*float(jev['input'])+r['usage']['output_tokens']*float(jev['output']) for r in responses)
        generation_cost=g['inputTokens']*float(llm['input'])+g['outputTokens']*float(llm['output'])
        cached=g['cachedInputTokens'];cache_cost=(g['inputTokens']-cached)*float(llm['input'])+cached*float(llm['input_cache_read'])+g['outputTokens']*float(llm['output'])
        row['evaluationCostUsd']=evaluation_cost;row['generationCostUsd']=generation_cost
        row['standardizedCostUsd']=generation_cost+evaluation_cost;row['cacheAdjustedCostUsd']=cache_cost+evaluation_cost
    summary={}
    for consumer in ['pip','digest','combined']:
        chosen=[pair for pair in pairs.values() if consumer=='combined' or pair['baseline']['consumer']==consumer]
        sums={arm:{'generationCalls':sum(p[arm]['generation']['calls'] for p in chosen),
                   'toolRequests':sum(p[arm]['generation']['toolRequests'] for p in chosen),
                   'qualityPasses':sum(p[arm]['qualityCheckPassed'] is True for p in chosen),
                   'standardizedCostUsd':sum(p[arm]['standardizedCostUsd'] for p in chosen),
                   'cacheAdjustedCostUsd':sum(p[arm]['cacheAdjustedCostUsd'] for p in chosen),
                   'totalLatencyMs':sum(p[arm]['elapsedMs'] for p in chosen),
                   'medianLatencyMs':statistics.median(p[arm]['elapsedMs'] for p in chosen)} for arm in ['baseline','jev']}
        baseline=sums['baseline']['standardizedCostUsd'];treatment=sums['jev']['standardizedCostUsd']
        cached_baseline=sums['baseline']['cacheAdjustedCostUsd'];cached_treatment=sums['jev']['cacheAdjustedCostUsd']
        sums.update({'cases':len(chosen),'standardizedSavingsUsd':baseline-treatment,'standardizedSavingsPercent':100*(baseline-treatment)/baseline,
                     'cacheAdjustedSavingsPercent':100*(cached_baseline-cached_treatment)/cached_baseline,
                     'baselineUsdPer1000':1000*baseline/len(chosen),'jevUsdPer1000':1000*treatment/len(chosen)})
        summary[consumer]=sums
    evals=[e for row in arms for e in row['evaluation']]
    successful=[e for e in evals if e.get('response')]
    failures=[e for e in evals if not e.get('response')]
    # Sensitivity reuses measured calls and routing scores. It is not another live arm.
    candidate_cost=0;candidate_skips=[];unsafe_skips=[]
    for name,pair in pairs.items():
        row=pair['jev'];response=next((e['response'] for e in row['evaluation'] if e.get('response')),None)
        answer=(response or {}).get('answers',{}).get('route',{})
        skip=answer.get('choice')=='skip' and answer.get('probabilities',{}).get('skip',0)>=0.99
        candidate_cost+=row['evaluationCostUsd'] if skip else row['standardizedCostUsd']
        if skip:
            candidate_skips.append(name)
            if row['material']:unsafe_skips.append(name)
    base=summary['combined']['baseline']['standardizedCostUsd']
    sensitivity={'threshold':0.99,'estimatedCostUsd':candidate_cost,'estimatedSavingsPercent':100*(base-candidate_cost)/base,'skippedCases':candidate_skips,'materialCasesSkipped':unsafe_skips,'counterfactual':True}
    result={'manifest':manifest,'rates':rates,'summary':summary,'evaluationSuccesses':len(successful),'evaluationFailures':len(failures),'evaluationFailureMessages':[e['error'] for e in failures],'sensitivity':sensitivity,'arms':arms}
    out=args.output;out.mkdir(parents=True,exist_ok=True)
    (out/'metrics.json').write_text(json.dumps(result,indent=2)+'\n')
    table=['| Workload | Cases | Baseline calls | Jev calls | Baseline USD | Jev USD | Saving | Quality baseline / Jev |',
           '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |']
    for consumer,s in summary.items():
        table.append(f"| {consumer} | {s['cases']} | {s['baseline']['generationCalls']} | {s['jev']['generationCalls']} | {s['baseline']['standardizedCostUsd']:.6f} | {s['jev']['standardizedCostUsd']:.6f} | {s['standardizedSavingsPercent']:+.2f}% | {s['baseline']['qualityPasses']}/{s['cases']} / {s['jev']['qualityPasses']}/{s['cases']} |")
    report=['# Synthetic PiP and Digest savings comparison','',
            'Twelve hand-authored scenarios; one paired measurement per case. One-third of cases are irrelevant. Both arms run actual consumer loops and live generation through the development server; tools are simulated. No production data or calendar changes were used.','',
            'Prices are standardized estimates from reported token usage and the snapshotted catalog, not invoice totals. Failed evaluation requests without returned usage may have unreported cost. Negative savings means additional cost.','']+table+['',
            f"Jev: {len(successful)} successful responses, {len(failures)} failed evaluations. Circuit bypasses are not API successes.",'',
            '## Per-case measurements','',
            '| Case | Baseline ms | Jev ms | Baseline model calls | Jev model calls | Quality baseline / Jev |',
            '| --- | ---: | ---: | ---: | ---: | --- |']
    for name,p in pairs.items():
        report.append(f"| {name} | {p['baseline']['elapsedMs']} | {p['jev']['elapsedMs']} | {p['baseline']['generation']['calls']} | {p['jev']['generation']['calls']} | {p['baseline']['qualityCheckPassed']} / {p['jev']['qualityCheckPassed']} |")
    report += ['', '## Cache-adjusted estimates', '',
        '| Workload | Baseline USD | Jev USD | Apparent saving |',
        '| --- | ---: | ---: | ---: |']
    for consumer, values in summary.items():
        report.append(f"| {consumer} | {values['baseline']['cacheAdjustedCostUsd']:.6f} | {values['jev']['cacheAdjustedCostUsd']:.6f} | {values['cacheAdjustedSavingsPercent']:+.2f}% |")
    report += ['', 'Cache-adjusted costs use the returned cached-token counts and cache-read rate. Their apparent savings cannot be attributed to Jev: both arms made the same number of generation calls, and repeated paired prompts share cache state. The six/six order balance does not eliminate cross-case cache warm-up. The primary table standardizes cache prices to isolate usage and evaluator overhead.', '']
    report+=['','## Counterfactual threshold sensitivity','',f"Replaying the observed scores at 0.99 would skip {len(candidate_skips)} cases and estimate {sensitivity['estimatedSavingsPercent']:+.2f}% cost savings on this same workload. Material cases skipped: {len(unsafe_skips)}. This is a counterfactual, not a deployed policy or independent validation. It is insufficient to establish a safe production threshold.",'',
             '## Limits','',
             '- The fixture distribution is artificial; dollars per 1,000 apply only to comparable eligible jobs, not all messages or an account bill.',
             '- Temperature 0, reasoning none and the output cap were fixed for both arms. Production defaults and account-specific Digest models may differ.',
             '- Prompt caching, generation variability, the SSH relay and local-to-Gateway evaluation routing affect latency and costs. Cache-adjusted estimates are provided separately in metrics.json.',
             '- Quality checks verify selected actions and cited item categories. They are coarse tests, not comprehensive human quality ratings.',
             '- One realization per scenario cannot establish model reliability or population significance. No p-values or population confidence intervals are reported.',
             '- Production feature flags and thresholds were not changed.','',
             '## Evidence and references','',
             '- raw-results.json: checkpointed synthetic responses, usage and errors.',
             '- metrics.json: paired costs, cache-adjusted estimates and threshold sensitivity.',
             '- https://ai-gateway.vercel.sh/v1/models: price snapshot.',
             '- Kassis, Agarwal, He, Patel and Brueckner (2026), Scientific Agent Skills: https://doi.org/10.48550/arXiv.2609.00065.','']
    report += ['', '## Claim candidates', '',
        '- Claim: On this fixed suite, current Jev routing increased standardized known-usage cost by the measured percentage.',
        '  - Source evidence: metrics.json and raw-results.json; 12 complete paired scenarios.',
        '  - Allowed wording: observed on these synthetic fixtures at the snapshotted token prices.',
        '  - Forbidden stronger wording: a reliable production billing forecast or a significant population effect.',
        '  - Uncertainty: one realization per case, artificial case mix, provider-rate-limit failures and unreported failed-request usage.',
        '  - Next check: a full healthy-evaluator run on a larger independent synthetic suite with repeated measurements.',
        '  - Decision: keep with scope limitations.', '',
        '- Claim: PiP and Digest generation continued despite evaluator rate limits or circuit bypasses.',
        '  - Source evidence: each affected treatment arm completed and passed its fixture check.',
        '  - Allowed wording: fallback worked in the observed synthetic run with live generation and simulated tool effects.',
        '  - Forbidden stronger wording: production reliability is guaranteed or server authorization was end-to-end tested.',
        '  - Uncertainty: restricted fixture set and simulated plan-card server.',
        '  - Next check: isolated full-stack failure injection with synthetic accounts.',
        '  - Decision: keep with scope limitations.', '']
    (out/'analysis-report.md').write_text('\n'.join(report))
    stats=['# Descriptive statistics and inference limits','', 'The unit is a scenario, with two repeated conditions. Seed 1601 fixes scenario order and six baseline-first/six treatment-first assignments. There is one provider realization per cell. Cases were hand-authored, so inferential tests and population confidence intervals would overstate evidence; they are intentionally omitted.','']
    for consumer in ['pip','digest']:
        for arm in ['baseline','jev']:
            rows=[r for r in arms if r['consumer']==consumer and r['arm']==arm]
            times=[r['elapsedMs'] for r in rows]
            stats.append(f"- {consumer}/{arm}: n={len(rows)}, latency mean {statistics.mean(times):.1f} ms, sample SD {statistics.stdev(times):.1f} ms. Dispersion is across scenarios, not repeated-run variability.")
    stats+=['','Effect sizes are paired total-cost differences and percent changes in metrics.json. No multiple-comparison significance claims are made.','',
            'Allowed claim: the observed cost on these fixtures changed by the recorded amount. Forbidden stronger claim: the same percentage will be saved on production traffic, or no material message will ever be skipped.','']
    (out/'stats-appendix.md').write_text('\n'.join(stats))
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    figures=out/'figures';figures.mkdir(exist_ok=True)
    previews=figures/'.preview';previews.mkdir(exist_ok=True)
    plt.rcParams.update({'font.size':10,'axes.spines.top':False,'axes.spines.right':False,'svg.fonttype':'none'})
    fig,ax=plt.subplots(figsize=(7,4))
    for i,consumer in enumerate(['pip','digest']):
        s=summary[consumer]
        ax.bar(i-.18,s['baselineUsdPer1000'],.34,color='#4477AA',label='Baseline' if i==0 else None)
        ax.bar(i+.18,s['jevUsdPer1000'],.34,color='#EE7733',label='With Jev' if i==0 else None)
    ax.set_xticks([0,1],['PiP','Digest']);ax.set_ylabel('Estimated USD per 1,000 comparable jobs');ax.set_title('Observed token-priced cost on synthetic cases');ax.set_ylim(bottom=0);ax.legend();fig.tight_layout();fig.savefig(previews/'cost-comparison.png',dpi=170);fig.savefig(figures/'cost-comparison.svg');plt.close(fig)
    names=list(pairs);fig,ax=plt.subplots(figsize=(9,6));y=list(range(len(names)))
    ax.scatter([pairs[n]['baseline']['elapsedMs']/1000 for n in names],y,color='#4477AA',label='Baseline',marker='o')
    ax.scatter([pairs[n]['jev']['elapsedMs']/1000 for n in names],y,color='#EE7733',label='With Jev',marker='x')
    for i,n in enumerate(names):ax.plot([pairs[n]['baseline']['elapsedMs']/1000,pairs[n]['jev']['elapsedMs']/1000],[i,i],color='#BBBBBB',zorder=0)
    ax.set_yticks(y,names);ax.invert_yaxis();ax.set_xlabel('Observed job seconds (includes SSH relay)');ax.set_title('Paired latency; one measurement per case');ax.set_xlim(left=0);ax.legend();fig.tight_layout();fig.savefig(previews/'paired-latency.png',dpi=170);fig.savefig(figures/'paired-latency.svg');plt.close(fig)
    for svg in figures.glob('*.svg'):
        svg.write_text('\n'.join(line.rstrip() for line in svg.read_text().splitlines()) + '\n')
    (out/'figure-catalog.md').write_text('''# Figure interpretation

- **cost-comparison**: sums measured usage at catalog prices, scaled per 1,000 comparable jobs; no error bars because the fixtures are fixed, with one realization each. Compare whether evaluator overhead is offset by changed generation usage. This does not establish an account-wide savings rate.
- **paired-latency**: connects baseline and Jev times for each scenario; no error bars or independence claim across conditions. Inspect whether time increases on jobs that still generate. Timing includes the shared SSH relay, so these are benchmark timings rather than production SLA predictions.

Both figures use all complete pairs and distinguish the two conditions by position/marker as well as color.
''')
    (out/'raw-results.json').write_text(json.dumps(data,indent=2)+'\n')
    print(json.dumps({'summary':summary,'evaluationSuccesses':len(successful),'evaluationFailures':len(failures),'sensitivity':sensitivity},indent=2))

if __name__=='__main__':main()
