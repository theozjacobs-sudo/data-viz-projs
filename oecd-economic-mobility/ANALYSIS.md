# Why did the ladder's rungs move apart?

Deeper cuts from the live IDD pull (`scripts/analyze.py` reproduces every
number from `data/idd_data.csv`). The dashboard shows *that* inequality rose
almost everywhere since the mid-1980s; the IDD's market-income Gini and
decile ratios let us say something about *why* — and the answer differs
sharply by country.

## 1. Markets pulled apart, and welfare states retreated — but the mix varies

Disposable (post-tax-and-transfer) inequality can rise for two reasons:
market incomes spread out, or redistribution stops keeping up. Writing
`disposable Gini = market Gini × (1 − redistribution share)` and holding each
country's mid-1980s redistribution share against today's market Gini splits
the observed change into the two channels (working-age population, which
avoids the pension artifact in market-income Ginis):

| Pattern | Countries | Reading |
| --- | --- | --- |
| **Redistribution retreat dominates** | Sweden (+0.055 of +0.089), Netherlands (+0.053 of +0.037 — market inequality actually *fell*) | The welfare state pulled back. Sweden cut its redistribution share from 38% to 24%, the Netherlands from 38% to 25%. |
| **Both channels** | Germany, Denmark, Finland, UK, New Zealand | Markets spread ~½–⅔ of the rise; weaker redistribution the rest. Even Denmark trimmed redistribution (36%→30%). |
| **Market forces, resisted** | Norway (+0.070 market, −0.010 redistribution), Italy, Japan, Canada | Market inequality surged but redistribution *strengthened*, absorbing part of it. Norway's redistribution rose to 30%; Japan's from 11% to 17%. |

So "inequality rose" is really three different stories: Sweden chose it
(policy), Norway fought it (markets), and most of Northern Europe got both.

## 2. Denmark's exception: the top stretched, the floor held

Decile ratios locate *where* each distribution widened (total population,
earliest ≥1975 vs latest):

- **Denmark**: P90/P50 +0.18, P50/P10 **−0.02**. All of Denmark's widening
  is the top pulling away; the distance from the middle down to the bottom
  decile is unchanged in four decades. That is exactly the shape you'd
  expect from the country that kept its 2-generation elevator: mobility is
  about the climb from the bottom, and Denmark's bottom never fell away.
- **Germany, UK, New Zealand, Japan, Israel**: the floor slipped —
  P50/P10 rose +0.37 to +0.49, as much or more than the top stretched.
  The UK got both (+0.25 top, +0.41 bottom).
- **Netherlands**: entirely a bottom-half story (top ratio *fell*),
  consistent with its redistribution-retreat signature above.
- **Counter-trend**: Greece (−0.67/−0.76), Mexico, Türkiye compressed from
  very unequal starting points.

## 3. The Gatsby link is tight — and tighter with today's inequality

Across all 30 dashboard countries, latest Gini vs intergenerational earnings
persistence: **r = +0.75**. Restricting to the 15 countries with mid-1980s
data, today's Gini correlates at +0.74 vs +0.60 for the 1980s Gini. With
n=15 that gap is suggestive, not conclusive — but it leans against the
comforting reading that today's inequality only matters for the *next*
generation's mobility; inequality and immobility move together in the
present tense.

## Caveats

- Accounting decomposition, not causal inference: the counterfactual holds
  the redistribution *share* fixed and ignores behavioral responses
  (taxes/transfers themselves shape pre-tax earnings).
- Methodology break: series mix the pre-2012 and post-2012 income
  definitions at the break year; level shifts there are small for these
  countries but not zero.
- Persistence estimates (the Gatsby y-axis) are single-vintage (2018 report,
  cohorts raised mostly in the 1960s–80s) — the OECD publishes no live
  mobility dataflow, so the time dimension of mobility itself is unobserved.
- US market-income series under the current definition lacks a 1980s
  anchor, so the US is absent from the decomposition table.
