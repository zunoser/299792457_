from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from plotly.io import to_html

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOTS = ROOT / "snapshots"
OUTPUT = ROOT / "dashboard" / "index.html"
TIMEZONE = "Asia/Tokyo"
DAY_ORDER = ["月", "火", "水", "木", "金", "土", "日"]
COLORS = {
    "ink": "#152a38",
    "muted": "#60727d",
    "paper": "#edf3f4",
    "panel": "#f9fcfc",
    "grid": "#cfdbde",
    "post": "#087e8b",
    "reply": "#ff5a5f",
    "quote": "#725ac1",
    "repost": "#809848",
    "glow": "#f4d35e",
}
KIND_ORDER = ["投稿", "返信", "引用", "リポスト"]
KIND_COLORS = {
    "投稿": COLORS["post"],
    "返信": COLORS["reply"],
    "引用": COLORS["quote"],
    "リポスト": COLORS["repost"],
}


def load_archive(snapshot_root: Path = SNAPSHOTS) -> pd.DataFrame:
    records = []
    for path in sorted(snapshot_root.glob("*/*/*.json")):
        data = json.loads(path.read_text())
        tweet = data["tweet"]
        legacy = tweet["legacy"]
        created_at = pd.to_datetime(legacy["createdAt"], utc=True).tz_convert(TIMEZONE)
        reply_to = legacy.get("inReplyToScreenName")
        kind = (
            "リポスト"
            if "retweeted" in data
            else "返信"
            if reply_to or legacy.get("inReplyToUserIdStr")
            else "引用"
            if legacy["isQuoteStatus"]
            else "投稿"
        )
        records.append(
            {
                "id": tweet["restId"],
                "created_at": created_at,
                "date": created_at.date(),
                "hour": created_at.hour,
                "weekday": DAY_ORDER[created_at.weekday()],
                "kind": kind,
                "reply_to": reply_to,
                "text": legacy["fullText"],
            }
        )

    if not records:
        raise ValueError(f"No snapshot JSON files found under {snapshot_root}")
    return (
        pd.DataFrame(records).sort_values(["created_at", "id"]).reset_index(drop=True)
    )


def style_figure(figure: go.Figure, *, height: int) -> go.Figure:
    figure.update_layout(
        height=height,
        margin={"l": 48, "r": 24, "t": 24, "b": 48},
        paper_bgcolor=COLORS["panel"],
        plot_bgcolor=COLORS["panel"],
        font={"family": "Inter, 'Noto Sans JP', sans-serif", "color": COLORS["ink"]},
        hoverlabel={"bgcolor": COLORS["ink"], "font_color": "white"},
        legend={
            "orientation": "h",
            "yanchor": "bottom",
            "y": 1.02,
            "xanchor": "right",
            "x": 1,
        },
    )
    figure.update_xaxes(gridcolor=COLORS["grid"], zeroline=False)
    figure.update_yaxes(gridcolor=COLORS["grid"], zeroline=False)
    return figure


def activity_figure(frame: pd.DataFrame) -> go.Figure:
    dates = pd.date_range(frame["date"].min(), frame["date"].max(), freq="D").date
    activity = (
        frame.groupby(["date", "kind"])
        .size()
        .unstack(fill_value=0)
        .reindex(index=dates, fill_value=0)
        .reindex(columns=KIND_ORDER, fill_value=0)
        .rename_axis("date")
        .reset_index()
        .melt(id_vars="date", var_name="kind", value_name="count")
    )
    figure = px.bar(
        activity,
        x="date",
        y="count",
        color="kind",
        category_orders={"kind": KIND_ORDER},
        color_discrete_map=KIND_COLORS,
        labels={"date": "日付", "count": "件数", "kind": "種類"},
    )
    figure.update_traces(
        hovertemplate="%{x|%Y-%m-%d}<br>%{fullData.name}: %{y}件<extra></extra>"
    )
    return style_figure(figure, height=380)


def rhythm_figure(frame: pd.DataFrame) -> go.Figure:
    rhythm = (
        frame.groupby(["weekday", "hour"])
        .size()
        .unstack(fill_value=0)
        .reindex(index=DAY_ORDER, columns=range(24), fill_value=0)
    )
    figure = go.Figure(
        go.Heatmap(
            z=rhythm.values,
            x=list(range(24)),
            y=DAY_ORDER,
            colorscale=[
                [0, COLORS["paper"]],
                [0.35, "#9ccbd0"],
                [0.7, COLORS["post"]],
                [1, COLORS["ink"]],
            ],
            colorbar={"title": "件数", "thickness": 12},
            hovertemplate="%{y}曜日 %{x}時台<br>%{z}件<extra></extra>",
        )
    )
    figure.update_xaxes(title="投稿時刻（日本時間）", dtick=2)
    figure.update_yaxes(title="")
    return style_figure(figure, height=380)


def reply_figure(frame: pd.DataFrame) -> go.Figure:
    replies = frame.dropna(subset=["reply_to"])
    partners = (
        replies.groupby("reply_to")
        .size()
        .nlargest(10)
        .sort_values()
        .reset_index(name="count")
    )
    if partners.empty:
        figure = go.Figure()
        figure.add_annotation(text="返信データはまだありません", showarrow=False)
    else:
        figure = px.bar(
            partners,
            x="count",
            y="reply_to",
            orientation="h",
            color_discrete_sequence=[COLORS["reply"]],
            labels={"count": "返信数", "reply_to": "返信先"},
        )
        figure.update_traces(
            marker_line_width=0,
            hovertemplate="@%{y}<br>%{x}件<extra></extra>",
        )
        figure.update_yaxes(tickprefix="@")
    return style_figure(figure, height=380)


def chart_html(
    figure: go.Figure, div_id: str, *, include_plotlyjs: bool | str = False
) -> str:
    return to_html(
        figure,
        full_html=False,
        include_plotlyjs=include_plotlyjs,
        config={"displaylogo": False, "responsive": True},
        div_id=div_id,
    )


def build_dashboard(frame: pd.DataFrame) -> str:
    first = frame["created_at"].min()
    latest = frame["created_at"].max()
    reply_count = int((frame["kind"] == "返信").sum())
    reply_ratio = reply_count / len(frame)
    active_days = frame["date"].nunique()

    activity = chart_html(
        activity_figure(frame), "activity-chart", include_plotlyjs="cdn"
    )
    rhythm = chart_html(rhythm_figure(frame), "rhythm-chart")
    replies = chart_html(reply_figure(frame), "reply-chart")

    return f"""<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>@299792457_ activity archive</title>
  <style>
    :root {{ --ink: {COLORS["ink"]}; --muted: {COLORS["muted"]}; --paper: {COLORS["paper"]};
      --panel: {COLORS["panel"]}; --grid: {COLORS["grid"]}; --post: {COLORS["post"]};
      --reply: {COLORS["reply"]}; --glow: {COLORS["glow"]}; }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; background: var(--paper); color: var(--ink);
      font-family: Inter, "Noto Sans JP", system-ui, sans-serif; }}
    main {{ width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 42px 0 64px; }}
    header {{ display: grid; grid-template-columns: 1.4fr 1fr; gap: 24px; align-items: end;
      border-top: 7px solid var(--ink); padding: 26px 0 22px; }}
    .eyebrow {{ color: var(--post); font: 700 12px/1.2 ui-monospace, monospace;
      letter-spacing: .16em; text-transform: uppercase; }}
    h1 {{ margin: 8px 0 10px; font: 800 clamp(38px, 8vw, 92px)/.88 "Arial Narrow", Impact, sans-serif;
      letter-spacing: -.045em; }}
    .intro {{ max-width: 42rem; color: var(--muted); line-height: 1.7; }}
    .signal {{ justify-self: end; width: min(100%, 330px); aspect-ratio: 2.3;
      background: repeating-linear-gradient(90deg, transparent 0 14px, rgba(8,126,139,.13) 14px 15px),
        linear-gradient(135deg, var(--glow), var(--reply));
      clip-path: polygon(0 58%, 8% 58%, 13% 20%, 20% 83%, 27% 43%, 35% 58%, 100% 58%, 100% 100%, 0 100%); }}
    .stats {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--grid);
      border: 1px solid var(--grid); margin: 18px 0 28px; }}
    .stat {{ background: var(--panel); padding: 18px; }}
    .stat strong {{ display: block; font: 800 30px/1 "Arial Narrow", sans-serif; }}
    .stat span {{ color: var(--muted); font-size: 12px; }}
    .grid {{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }}
    article {{ min-width: 0; background: var(--panel); border: 1px solid var(--grid); padding: 20px; }}
    article.wide {{ grid-column: 1 / -1; }}
    h2 {{ margin: 0; font-size: 18px; }}
    article p {{ margin: 5px 0 10px; color: var(--muted); font-size: 13px; }}
    footer {{ margin-top: 22px; color: var(--muted); font: 12px/1.6 ui-monospace, monospace; }}
    @media (max-width: 760px) {{
      header, .grid {{ grid-template-columns: 1fr; }} .signal {{ display: none; }}
      .stats {{ grid-template-columns: repeat(2, 1fr); }} article.wide {{ grid-column: auto; }}
    }}
  </style>
</head>
<body>
<main>
  <header>
    <div><div class="eyebrow">Signal log / Tokyo time</div><h1>299792457_</h1>
      <div class="intro">X投稿アーカイブの活動記録。投稿日時と返信先から、日々の密度と会話の軌道を可視化しています。</div></div>
    <div class="signal" aria-hidden="true"></div>
  </header>
  <section class="stats" aria-label="概要">
    <div class="stat"><strong>{len(frame):,}</strong><span>保存済み投稿</span></div>
    <div class="stat"><strong>{active_days:,}</strong><span>活動日数</span></div>
    <div class="stat"><strong>{reply_ratio:.0%}</strong><span>返信の割合</span></div>
    <div class="stat"><strong>{latest:%m/%d}</strong><span>最新記録（{latest:%Y}）</span></div>
  </section>
  <section class="grid">
    <article class="wide"><h2>活動タイムライン</h2><p>{first:%Y年%m月%d日}から{latest:%Y年%m月%d日}まで。4つの投稿種別を日ごとに集計。</p>{activity}</article>
    <article><h2>一週間のリズム</h2><p>曜日と時間帯ごとの投稿密度。時刻はJST。</p>{rhythm}</article>
    <article><h2>会話の軌道</h2><p>アーカイブ内で返信した相手の上位10アカウント。</p>{replies}</article>
  </section>
  <footer>Generated from snapshots/*/*/*.json · Counts reflect archived records, not the complete X timeline.</footer>
</main>
</body>
</html>
"""


def main() -> None:
    frame = load_archive()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(build_dashboard(frame))
    print(f"Generated {OUTPUT.relative_to(ROOT)} from {len(frame)} archived posts.")


if __name__ == "__main__":
    main()
