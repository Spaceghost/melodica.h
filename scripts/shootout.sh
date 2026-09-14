#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUTDIR="$ROOT/build/shootout"
SCORES="$OUTDIR/scores.tsv"
mkdir -p "$OUTDIR"
: > "$SCORES"

run_lane() {
    lane=$1
    exe=$2
    output="$OUTDIR/$lane.txt"

    "$exe" | tee "$output"
    awk -v lane="$lane" '
        /^(json_ascii|json_payload|url_ascii|url_mixed|station_request)[[:space:]]/ {
            print lane "\t" $1 "\t" $2
        }
    ' "$output" >> "$SCORES"
}

run_lane c "$ROOT/build/c/bench"
run_lane odin "$ROOT/build/odin/bench"
run_lane zig "$ROOT/build/zig/bench"
run_lane nelua "$ROOT/build/nelua/bench"
run_lane codin "$ROOT/build/codin/bench"

awk '
BEGIN {
    lanes[1] = "c"
    lanes[2] = "odin"
    lanes[3] = "zig"
    lanes[4] = "nelua"
    lanes[5] = "codin"
    metrics[1] = "json_ascii"
    metrics[2] = "json_payload"
    metrics[3] = "url_ascii"
    metrics[4] = "url_mixed"
    metrics[5] = "station_request"
    floor = ENVIRON["SHOOTOUT_FLOOR"] + 0
    worst_floor = ENVIRON["SHOOTOUT_WORST_FLOOR"] + 0
}
{
    value[$1, $2] = $3 + 0
}
END {
    for (m = 1; m <= 5; ++m) {
        metric = metrics[m]
        leader[metric] = 0
        for (l = 1; l <= 5; ++l) {
            lane = lanes[l]
            if (value[lane, metric] > leader[metric]) leader[metric] = value[lane, metric]
        }
        if (leader[metric] <= 0) {
            printf "missing shootout metric: %s\n", metric > "/dev/stderr"
            exit 2
        }
    }

    print ""
    print "normalized shootout standings (leader per workload = 100%)"
    printf "%-8s %11s %11s %11s %11s %11s %10s %10s\n", \
        "lane", "json ascii", "json body", "url ascii", "url mixed", "station", "geo mean", "worst"

    failed = 0
    for (l = 1; l <= 5; ++l) {
        lane = lanes[l]
        sum_log = 0
        worst = 1
        printf "%-8s", lane
        for (m = 1; m <= 5; ++m) {
            metric = metrics[m]
            ratio = value[lane, metric] / leader[metric]
            if (ratio < worst) worst = ratio
            sum_log += log(ratio)
            printf " %10.1f%%", ratio * 100
        }
        geomean = exp(sum_log / 5)
        printf " %9.1f%% %9.1f%%\n", geomean * 100, worst * 100

        if ((floor > 0 && geomean < floor) ||
            (worst_floor > 0 && worst < worst_floor)) failed = 1
    }

    if (floor > 0 || worst_floor > 0) {
        printf "gate: geo mean >= %.1f%%, worst workload >= %.1f%%\n", \
            floor * 100, worst_floor * 100
    }
    exit failed
}
' "$SCORES"
