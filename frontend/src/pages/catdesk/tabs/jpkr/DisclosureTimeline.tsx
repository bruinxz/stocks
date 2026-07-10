import React from 'react';
import { Timeline, Tag, Typography } from 'antd';
import type { JpKrDisclosureEvent } from './types';

const { Text, Link } = Typography;

type DisclosureTimelineProps = {
  events: JpKrDisclosureEvent[];
  ariaLabel: string;
};

export function DisclosureTimeline({ events, ariaLabel }: DisclosureTimelineProps) {
  if (events.length === 0) {
    return (
      <div aria-label={ariaLabel}>
        <Text type="secondary">该标的暂无披露事件</Text>
      </div>
    );
  }

  return (
    <div aria-label={ariaLabel}>
      <Timeline
        items={events.map((evt) => ({
          key: `${evt.filed_at}-${evt.title}`,
          color: evt.source === 'EDINET' ? 'blue' : 'green',
          children: (
            <div>
              <div>
                <Tag color={evt.source === 'EDINET' ? 'blue' : 'green'}>
                  {evt.source}
                </Tag>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {new Date(evt.filed_at).toLocaleDateString()}
                </Text>
              </div>
              <div style={{ marginTop: 2 }}>
                {evt.doc_url ? (
                  <Link href={evt.doc_url} target="_blank" rel="noopener noreferrer">
                    {evt.title}
                  </Link>
                ) : (
                  <Text>{evt.title}</Text>
                )}
              </div>
              <Text type="secondary" style={{ fontSize: 12 }}>{evt.doc_type}</Text>
            </div>
          ),
        }))}
      />
    </div>
  );
}
