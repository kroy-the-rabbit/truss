import React, { useState } from 'react';
import { useAppStore } from '../state/store';
import { useEvents } from '../state/queries';
import { compileSuppressionRules, isEventSuppressed, normalizeResourceEvent } from '../lib/eventFilters';

interface EventsTabProps {
  name: string;
  namespace: string;
  kind: string;
  uid?: string;
}

function timeAgo(ts: string): string {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

export function EventsTab({ name, namespace, kind, uid }: EventsTabProps) {
  const { activeContext, eventSuppressionRules } = useAppStore();
  const events = useEvents(activeContext, namespace, kind, name, uid);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [showSuppressed, setShowSuppressed] = useState(false);

  if (events.isLoading) {
    return <div className="loading">Loading events...</div>;
  }

  if (events.error) {
    return <div className="events-error">Error loading events: {String(events.error)}</div>;
  }

  const items = events.data?.events || [];
  const compiledRules = compileSuppressionRules(eventSuppressionRules);
  const withSuppressed = items.map((ev) => ({
    ev,
    suppressed: isEventSuppressed(normalizeResourceEvent(ev as any), compiledRules),
  }));
  const hiddenCount = withSuppressed.filter((x) => x.suppressed).length;
  const visibleItems = showSuppressed ? withSuppressed : withSuppressed.filter((x) => !x.suppressed);

  if (visibleItems.length === 0 && hiddenCount === 0) {
    return <div className="events-empty">No events found for this resource</div>;
  }

  return (
    <div className="events-tab">
      {(hiddenCount > 0 || items.length > 0) && (
        <div className="events-controls">
          <span className="events-controls-note">
            {hiddenCount > 0 ? `${hiddenCount} event${hiddenCount === 1 ? '' : 's'} hidden by suppression rules` : 'No events hidden'}
          </span>
          {hiddenCount > 0 && (
            <label className="events-controls-toggle">
              <input type="checkbox" checked={showSuppressed} onChange={(e) => setShowSuppressed(e.target.checked)} />
              Show suppressed
            </label>
          )}
        </div>
      )}
      {visibleItems.length === 0 ? (
        <div className="events-empty">All events are hidden by suppression rules</div>
      ) : (
      <div className="events-table">
        <div className="events-header">
          <span className="ev-col-type">Type</span>
          <span className="ev-col-reason">Reason</span>
          <span className="ev-col-message">Message</span>
          <span className="ev-col-source">Source</span>
          <span className="ev-col-count">Count</span>
          <span className="ev-col-age">Age</span>
        </div>
        {visibleItems.map(({ ev, suppressed }, i) => (
          <React.Fragment key={i}>
            <div
              className={`events-row clickable ${ev.type === 'Warning' ? 'warning' : ''}${expandedIdx === i ? ' expanded' : ''}${suppressed ? ' suppressed' : ''}`}
              onClick={() => setExpandedIdx(expandedIdx === i ? null : i)}
            >
              <span className={`ev-col-type ev-type-${ev.type?.toLowerCase()}`}>{ev.type}</span>
              <span className="ev-col-reason">{ev.reason}</span>
              <span className="ev-col-message">{ev.message}</span>
              <span className="ev-col-source">{ev.source}</span>
              <span className="ev-col-count">{ev.count}</span>
              <span className="ev-col-age" title={ev.lastSeen}>{timeAgo(ev.lastSeen)}</span>
            </div>
            {expandedIdx === i && (
              <div className="event-detail">
                <div className="event-detail-row"><span className="event-detail-label">Type</span><span className="event-detail-value">{ev.type}</span></div>
                <div className="event-detail-row"><span className="event-detail-label">Reason</span><span className="event-detail-value">{ev.reason}</span></div>
                <div className="event-detail-row"><span className="event-detail-label">Message</span><span className="event-detail-value event-detail-message">{ev.message}</span></div>
                <div className="event-detail-row"><span className="event-detail-label">Source</span><span className="event-detail-value">{ev.source}</span></div>
                <div className="event-detail-row"><span className="event-detail-label">Count</span><span className="event-detail-value">{ev.count}</span></div>
                {ev.firstSeen && <div className="event-detail-row"><span className="event-detail-label">First Seen</span><span className="event-detail-value">{new Date(ev.firstSeen).toLocaleString()}</span></div>}
                {ev.lastSeen && <div className="event-detail-row"><span className="event-detail-label">Last Seen</span><span className="event-detail-value">{new Date(ev.lastSeen).toLocaleString()}</span></div>}
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
      )}
    </div>
  );
}
