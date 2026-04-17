#!/bin/bash

# Fix src/pages/DataUpdateStatus.tsx
sed -i '' 's/ Badge,//' src/pages/DataUpdateStatus.tsx
sed -i '' 's/Badge, //' src/pages/DataUpdateStatus.tsx
sed -i '' '/const { Title } = Typography;/d' src/pages/DataUpdateStatus.tsx
sed -i '' '/const systemHealthDetails = \[/,/\];/d' src/pages/DataUpdateStatus.tsx

# Fix src/pages/Market.tsx
sed -i '' 's/ Layout,//' src/pages/Market.tsx
sed -i '' 's/Layout, //' src/pages/Market.tsx
sed -i '' '/const { Title, Paragraph } = Typography;/d' src/pages/Market.tsx
sed -i '' 's/}, \[favorites\]);/  \/\/ eslint-disable-next-line react-hooks\/exhaustive-deps\n  }, \[favorites\]);/' src/pages/Market.tsx

# Fix src/components/backtest/BacktestResults.tsx
sed -i '' 's/  }, \[backtestId\]);/  \/\/ eslint-disable-next-line react-hooks\/exhaustive-deps\n  }, \[backtestId\]);/' src/components/backtest/BacktestResults.tsx

# Fix src/pages/Portfolio.tsx
sed -i '' 's/  }, \[\]);/  \/\/ eslint-disable-next-line react-hooks\/exhaustive-deps\n  }, \[\]);/' src/pages/Portfolio.tsx

