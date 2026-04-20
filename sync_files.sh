#!/bin/bash
scp -P 14126 -o StrictHostKeyChecking=no backend/src/api/controllers/UserController.ts root@103.242.3.87:/opt/stocks/backend/src/api/controllers/
scp -P 14126 -o StrictHostKeyChecking=no backend/src/api/routes/user.routes.ts root@103.242.3.87:/opt/stocks/backend/src/api/routes/
scp -P 14126 -o StrictHostKeyChecking=no backend/src/index.ts root@103.242.3.87:/opt/stocks/backend/src/
scp -P 14126 -o StrictHostKeyChecking=no frontend/src/services/userService.ts root@103.242.3.87:/opt/stocks/frontend/src/services/
scp -P 14126 -o StrictHostKeyChecking=no frontend/src/pages/UserManagement.tsx root@103.242.3.87:/opt/stocks/frontend/src/pages/
scp -P 14126 -o StrictHostKeyChecking=no frontend/src/App.tsx root@103.242.3.87:/opt/stocks/frontend/src/
