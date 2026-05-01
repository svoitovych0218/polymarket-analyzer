# Idea: Detecting Logical Mismatches on Prediction Markets

## Overview
The system identifies **logical inconsistencies between related prediction markets** on :contentReference[oaicite:0]{index=0}.  
These inconsistencies occur when prices violate basic probability laws or logical relationships between events.

The goal is to systematically detect these mismatches and surface **arbitrage opportunities**.

---

## 1. Complementary Outcome Mismatch

### Definition
Two markets represent **mutually exclusive and exhaustive outcomes** of the same event.

### Logical Rule
If A and B are complements:
- A = NOT B  
- Their probabilities must sum to 1

### Example
- "Trump will win election" (Yes/No)
- "Biden will win election" (Yes/No)

### Mismatch Pattern
- Price(Trump NO) ≠ Price(Biden YES)
- Or:
  - Price(Trump YES) + Price(Biden YES) < 1

### Insight
Markets are pricing the same reality differently → duplication inconsistency.

---

## 2. Temporal Dependency Mismatch

### Definition
One event happening earlier **guarantees** another event defined over a longer timeframe.

### Logical Rule
If event A implies event B:
- P(A) ≤ P(B)

### Example
- "Bitcoin hits $80k in May"
- "Bitcoin hits $80k in June"

### Mismatch Pattern
- Price(May YES) > Price(June YES)

### Insight
Earlier occurrence cannot be more likely than a later-inclusive one.

---

## 3. Threshold Ordering Mismatch

### Definition
Markets define **ordered thresholds** of the same variable.

### Logical Rule
Higher thresholds must have lower or equal probability:
- P(X > 60k) ≥ P(X > 70k) ≥ P(X > 80k)

### Example
- "BTC > 60k in 2025"
- "BTC > 70k in 2025"
- "BTC > 80k in 2025"

### Mismatch Pattern
- Price(>70k) > Price(>60k)

### Insight
Violates monotonicity of cumulative probabilities.

---

## 4. Exhaustive Partition Mismatch

### Definition
A set of markets splits all possible outcomes into **non-overlapping buckets**.

### Logical Rule
- Sum of probabilities = 1

### Example
- "BTC ends 2025 below 50k"
- "BTC ends 2025 between 50k–70k"
- "BTC ends 2025 between 70k–90k"
- "BTC ends 2025 above 90k"

### Mismatch Pattern
- Sum of YES prices < 1  
- Sum of YES prices > 1

### Insight
Market is underpricing or overpricing the total probability space.

---

## 5. Conditional Probability Mismatch

### Definition
Markets represent **joint vs individual events**.

### Logical Rule
- P(A AND B) ≤ P(A)
- P(A AND B) ≤ P(B)

### Example
- "Trump wins election"
- "Trump wins AND Republicans control Congress"

### Mismatch Pattern
- Price(joint event) > Price(single event)

### Insight
Joint probability exceeding marginal is logically impossible.

---

## 6. Multi-Market Constraint Violation

### Definition
Relationships across **three or more interconnected markets**.

### Logical Rules
- P(A ∧ B) ≥ P(A) + P(B) − 1  
- P(A ∧ B) ≤ min(P(A), P(B))

### Example
- "Recession in 2025"
- "Fed cuts rates in 2025"
- "Recession AND rate cuts"

### Mismatch Pattern
- Joint probability outside valid bounds

### Insight
Breaks fundamental probability inequalities → higher-order inconsistency.

---

## 7. Cross-Market Definition Mismatch

### Definition
Markets appear similar but differ in **resolution criteria**.

### Example
- "BTC hits 80k in 2025"
- "BTC touches 80k on Binance"

### Mismatch Pattern
- Large price divergence despite apparent similarity

### Insight
Differences in:
- Data source
- Definition of "hit"
- Resolution timing

This creates **apparent arbitrage**, but with embedded risk.

---

## 8. Correlation Mispricing

### Definition
Markets with **strong real-world correlation** priced independently.

### Example
- "Trump wins election"
- "Republicans win Senate"

### Mismatch Pattern
- Combined probability inconsistent with expected correlation

### Insight
Not a strict logical violation, but a **statistical inefficiency**.

---

## Summary

The system should detect mismatches across:

- Complementarity (A vs NOT A)
- Temporal inclusion (early vs late)
- Monotonic thresholds (ordered probabilities)
- Exhaustive partitions (sum = 1)
- Conditional relationships (joint vs marginal)
- Multi-variable constraints (probability bounds)
- Definition inconsistencies (resolution mismatch)
- Correlation inefficiencies (soft signals)

These patterns represent **structural inefficiencies**, not random noise.