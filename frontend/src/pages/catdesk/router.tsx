import React from 'react';
import { Route } from 'react-router-dom';

const CatDeskLayout = React.lazy(() => import('./CatDeskLayout'));

export const catDeskRoute = (
  <Route path="/catdesk" element={<CatDeskLayout />}>
    <Route index element={null} />
  </Route>
);
