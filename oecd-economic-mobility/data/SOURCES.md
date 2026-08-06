# Data sources & provenance

## mobility_snapshot.csv (curated, pending final verification)

- **generations_to_mean_income** — OECD (2018), *A Broken Social Elevator? How to
  Promote Social Mobility*, https://doi.org/10.1787/9789264301085-en. Expected
  number of generations for a child born into the bottom 10% of the income
  distribution to approach the country's mean income (based on current earnings
  persistence). OECD-24 average: 4.5 generations.
  Independently confirmed values: DNK 2; GBR/ITA/CHE 5; CHN/IND 7; BRA 9; COL 11;
  avg 4.5 (Statista chart 30387; Equally Ours summary of the report).
- **earnings_elasticity** — intergenerational earnings elasticity (father–son),
  higher = LESS mobile. Sources per row: `Corak2013` = Corak, "Income Inequality,
  Equality of Opportunity, and Intergenerational Mobility," *JEP* 27(3), 2013
  (canonical Great Gatsby Curve dataset); `OECD2018` = OECD (2018) Figure 1.13
  (approximate readings — TO VERIFY against the report PDF once network access
  to oecd.org is available).

## Status

- [ ] Verify OECD2018-sourced elasticities against the report PDF
- [ ] Check the March 2026 OECD report *Intergenerational social mobility across
      OECD countries* (https://doi.org/10.1787/6d76ec2a-en) for updated indicators
      and a possible SDMX dataflow
- [ ] idd_data.csv — fetched live from sdmx.oecd.org by scripts/fetch_oecd.py
