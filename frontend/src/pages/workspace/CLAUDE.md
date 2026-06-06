# Workspace Shells

The 6 files in this directory are the **only** top-level navigation entries in `frontend/src/App.tsx`. Future stories (US-002 / US-015..US-018) build out each workspace into a tabbed page, but the **set of 6 shells must stay fixed** — adding a 7th breaks the PRD's information-architecture promise.

## How the workspaces map to legacy pages

| Workspace        | Absorbs (legacy pages)                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TodayWorkspace   | TodayCommandCenter, Recommendations, RiskAlerts, Dashboard                                                                                                                |
| FactorWorkspace  | Screener, factor-related parts of Quant\*                                                                                                                                 |
| LabWorkspace     | StrategyExperimentLab, AutonomousOptimizationLab, QuantBacktestLab, QuantPerformanceDashboard, QuantSignalPool, QuantStrategyLibrary, Strategy, AIAdvisor, Backtest       |
| PortfolioWorkspace | Portfolio, AutonomousTradingOverview, AutonomousRecommendationTracker, PaperTrading, ReviewCenter, LiveTrading, RecommendationPerformance, RecommendationTradeOutcomes |
| DataWorkspace    | Market, DataUpdateStatus, TaskScheduler, SystemLogs                                                                                                                       |
| SettingsWorkspace | Profile, UserManagement                                                                                                                                                  |

## When implementing a workspace tab

1. Edit the shell file in place — do **not** create a sibling page.
2. Use `WorkspaceLayout` (added in US-002) for the chrome; only the inner content per tab is unique.
3. Reuse the legacy component as-is when possible — import from `../<LegacyName>` and render it inside the relevant tab.
4. Remove the corresponding legacy `/legacy/*` route in `App.tsx` only after the workspace tab fully covers the legacy functionality.
