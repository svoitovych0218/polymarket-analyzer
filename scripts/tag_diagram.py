import sqlite3
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
import seaborn as sns
import numpy as np
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "polymarket.db")
TOP_N = 20

con = sqlite3.connect(DB_PATH)

# Top N tags by event count
top_tags = pd.read_sql_query(f"""
    SELECT t.label, COUNT(et.event_id) as event_count
    FROM tags t
    JOIN event_tags et ON t.id = et.tag_id
    GROUP BY t.id
    ORDER BY event_count DESC
    LIMIT {TOP_N}
""", con)

labels = top_tags["label"].tolist()

# Co-occurrence matrix: events sharing both tag A and tag B
cooc = np.zeros((TOP_N, TOP_N), dtype=int)

for i, label_a in enumerate(labels):
    for j, label_b in enumerate(labels):
        if i == j:
            cooc[i][j] = top_tags.iloc[i]["event_count"]
        elif j < i:
            cooc[i][j] = cooc[j][i]  # symmetric — fill from upper triangle
        else:
            count = con.execute("""
                SELECT COUNT(DISTINCT a.event_id)
                FROM event_tags a
                JOIN event_tags b ON a.event_id = b.event_id
                JOIN tags ta ON a.tag_id = ta.id AND ta.label = ?
                JOIN tags tb ON b.tag_id = tb.id AND tb.label = ?
            """, (label_a, label_b)).fetchone()[0]
            cooc[i][j] = count

con.close()

# ── Layout ────────────────────────────────────────────────────────────────────
fig = plt.figure(figsize=(18, 14))
fig.patch.set_facecolor("#0f1117")
gs = gridspec.GridSpec(2, 1, height_ratios=[1, 2.5], hspace=0.35)

bar_ax = fig.add_subplot(gs[0])
heat_ax = fig.add_subplot(gs[1])

# ── Bar chart ─────────────────────────────────────────────────────────────────
colors = sns.color_palette("rocket", TOP_N)[::-1]
bar_ax.barh(labels[::-1], top_tags["event_count"][::-1], color=colors, edgecolor="none")
bar_ax.set_facecolor("#0f1117")
bar_ax.set_xlabel("Number of events", color="#cccccc", fontsize=11)
bar_ax.set_title(f"Top {TOP_N} tags by event count", color="white", fontsize=13, pad=10)
bar_ax.tick_params(colors="#cccccc")
for spine in bar_ax.spines.values():
    spine.set_edgecolor("#333333")
for bar, val in zip(bar_ax.patches, top_tags["event_count"][::-1]):
    bar_ax.text(bar.get_width() + 20, bar.get_y() + bar.get_height() / 2,
                f"{val:,}", va="center", color="#cccccc", fontsize=8)

# ── Heatmap (lower triangle only, excluding diagonal) ─────────────────────────
mask_upper = np.triu(np.ones_like(cooc, dtype=bool), k=0)  # hide diagonal + upper
cooc_df = pd.DataFrame(cooc, index=labels, columns=labels)

sns.heatmap(
    cooc_df,
    mask=mask_upper,
    ax=heat_ax,
    cmap="rocket",
    linewidths=0.4,
    linecolor="#1a1a2e",
    annot=True,
    fmt="d",
    annot_kws={"size": 7, "color": "white"},
    cbar_kws={"label": "shared events", "shrink": 0.6},
)

heat_ax.set_facecolor("#0f1117")
heat_ax.set_title("Tag co-occurrence — events shared between each pair", color="white", fontsize=13, pad=10)
heat_ax.tick_params(axis="x", rotation=40, colors="#cccccc", labelsize=9)
heat_ax.tick_params(axis="y", rotation=0, colors="#cccccc", labelsize=9)
heat_ax.collections[0].colorbar.ax.yaxis.label.set_color("#cccccc")
heat_ax.collections[0].colorbar.ax.tick_params(colors="#cccccc")

out_path = os.path.join(os.path.dirname(__file__), "..", "data", "tag_diagram.png")
plt.savefig(out_path, dpi=150, bbox_inches="tight", facecolor=fig.get_facecolor())
print(f"Saved → {out_path}")
