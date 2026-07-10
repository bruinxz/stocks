import React from 'react';
import { TableColumn } from './TableColumn';

interface DomainRowWithoutIndexSignature {
  symbol: string;
  score: number;
}

const rows: DomainRowWithoutIndexSignature[] = [{ symbol: '7203', score: 88 }];

export const tableColumnDomainInterfaceFixture = (
  <TableColumn<DomainRowWithoutIndexSignature>
    rows={rows}
    columns={[
      {
        key: 'score',
        title: '评分',
        ariaLabel: '评分',
        render: (_, row) => row.score,
      },
    ]}
    rowKey="symbol"
  />
);
