import { combineReducers } from '@reduxjs/toolkit';
import authReducer from './authSlice';
import backtestReducer from './backtestSlice';

const rootReducer = combineReducers({
  auth: authReducer,
  backtest: backtestReducer,
});

export type RootState = ReturnType<typeof rootReducer>;
export default rootReducer;
