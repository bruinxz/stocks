import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface Backtest {
  id: number;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  symbol: string;
  start_date: string;
  end_date: string;
  strategyType: string;
  initial_capital: number;
  total_return: number;
  sharpe_ratio: number;
  max_drawdown: number;
  created_at: string;
}

export interface BacktestState {
  backtests: Backtest[];
  selectedBacktest: Backtest | null;
  loading: boolean;
  error: string | null;
}

const initialState: BacktestState = {
  backtests: [],
  selectedBacktest: null,
  loading: false,
  error: null,
};

const backtestSlice = createSlice({
  name: 'backtest',
  initialState,
  reducers: {
    fetchBacktestsStart: state => {
      state.loading = true;
      state.error = null;
    },
    fetchBacktestsSuccess: (state, action: PayloadAction<Backtest[]>) => {
      state.backtests = action.payload;
      state.loading = false;
      state.error = null;
    },
    fetchBacktestsFailure: (state, action: PayloadAction<string>) => {
      state.loading = false;
      state.error = action.payload;
    },
    selectBacktest: (state, action: PayloadAction<Backtest>) => {
      state.selectedBacktest = action.payload;
    },
    createBacktestStart: state => {
      state.loading = true;
      state.error = null;
    },
    createBacktestSuccess: (state, action: PayloadAction<Backtest>) => {
      state.backtests.unshift(action.payload);
      state.loading = false;
      state.error = null;
    },
    createBacktestFailure: (state, action: PayloadAction<string>) => {
      state.loading = false;
      state.error = action.payload;
    },
    updateBacktestStatus: (
      state,
      action: PayloadAction<{ id: number; status: Backtest['status'] }>
    ) => {
      const backtest = state.backtests.find(b => b.id === action.payload.id);
      if (backtest) {
        backtest.status = action.payload.status;
      }
      if (state.selectedBacktest && state.selectedBacktest.id === action.payload.id) {
        state.selectedBacktest.status = action.payload.status;
      }
    },
  },
});

export const {
  fetchBacktestsStart,
  fetchBacktestsSuccess,
  fetchBacktestsFailure,
  selectBacktest,
  createBacktestStart,
  createBacktestSuccess,
  createBacktestFailure,
  updateBacktestStatus,
} = backtestSlice.actions;
export default backtestSlice.reducer;
