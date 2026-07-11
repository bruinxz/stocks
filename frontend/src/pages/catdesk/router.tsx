import React from 'react';
import { Route } from 'react-router-dom';

const CatDeskLayout = React.lazy(() => import('./CatDeskLayout'));
const DisclaimerPage = React.lazy(() => import('./tabs/DisclaimerPage'));

export const catDeskRoute = (
  <Route path="/catdesk" element={<CatDeskLayout />}>
    <Route index element={null} />
    <Route path="disclaimer" element={<DisclaimerPage />} />
  </Route>
);
