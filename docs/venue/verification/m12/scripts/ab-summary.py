import re,glob,statistics,sys
S=sys.argv[1]
def load(tag):
    runs=[]
    for f in sorted(glob.glob(f"{S}/ab-{tag}-*.log")):
        d={}
        for line in open(f):
            m=re.match(r"\| (F\d[^|]*?) \| 1 \|[^|]*\| \d+ \| ([\d,]+) \| ([\d.]+) \| ([\d.]+) \| ([\d.]+) \|",line)
            if m: d[m.group(1)]=(int(m.group(2).replace(",","")),float(m.group(3)),float(m.group(4)),float(m.group(5)))
        if d: runs.append(d)
    return runs
a,b=load("9fcee80"),load("m12")
print(f"runs: baseline {len(a)}, m12 {len(b)}\n")
print("| Scenario | Baseline ops/s median (range) | M12 ops/s median (range) | Median Δ | Ranges separate? | Baseline p50/p95/p99 µs (medians) | M12 p50/p95/p99 µs (medians) |")
print("|---|---|---|---|---|---|---|")
for sc in a[0]:
    x=[r[sc][0] for r in a]; y=[r[sc][0] for r in b]
    mx,my=statistics.median(x),statistics.median(y)
    sep="yes" if max(x)<min(y) or max(y)<min(x) else "no"
    q=lambda rs,i: statistics.median([r[sc][i] for r in rs])
    print(f"| {sc} | {mx:,.0f} ({min(x):,}–{max(x):,}) | {my:,.0f} ({min(y):,}–{max(y):,}) | {100*(my-mx)/mx:+.1f} % | {sep} | {q(a,1):.1f} / {q(a,2):.1f} / {q(a,3):.1f} | {q(b,1):.1f} / {q(b,2):.1f} / {q(b,3):.1f} |")
