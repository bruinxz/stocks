#!/bin/bash

# Fix src/pages/DataUpdateStatus.tsx
sed -i '' 's/const { Title, Text } = Typography;/const { Text } = Typography;/' src/pages/DataUpdateStatus.tsx
sed -i '' 's/const \[systemHealthDetails, setSystemHealthDetails\] = useState<any>(null);//' src/pages/DataUpdateStatus.tsx
sed -i '' 's/setSystemHealthDetails(healthData);//' src/pages/DataUpdateStatus.tsx

# Fix src/pages/Market.tsx
sed -i '' 's/const { Title, Paragraph } = Typography;//' src/pages/Market.tsx

