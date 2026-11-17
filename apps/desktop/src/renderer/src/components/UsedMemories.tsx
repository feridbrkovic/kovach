import type { RetrievedItem } from "@kovach-dev/memory-contract";
import { useEffect, useState } from "react";
import { reasonLabel, truncate } from "../memory-format";
import { AlertIcon, BookIcon, BulbIcon, ChevronIcon, MemoryIcon, SparkleIcon } from "./icons";

const ICONS: Record<RetrievedItem["ref"]["type"], typeof MemoryIcon> = {
  memory: MemoryIcon,
  episode: BulbIcon,
  doc: BookIcon,
  skill: SparkleIcon,
};

const TYPE_LABELS: Record<RetrievedItem["ref"]["type"], string> = {
  memory: "Memory",
  episode: "Earlier fix",
  doc: "Docs",
  skill: "Skill",
};

/** What the agent pulled from memory to write one answer, as a collapsed list under it. */
export function UsedMemories(props: {
  messageId: string;
  load: (messageId: string) => Promise<RetrievedItem[]>;
  onOpenMemory: ((id: string) => void) | undefined;
}) {
  const { messageId, load } = props;
  const [items, setItems] = useState<RetrievedItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    void load(messageId).then((list) => !cancelled && setItems(list));
    return () => {
      cancelled = true;
    };
  }, [messageId, load]);

  if (items.length === 0) return null;
  const n = items.length;
  return (
    <details className="used-memories">
      <summary>
        <MemoryIcon size={13} />
        <span>{`Used ${n} ${n === 1 ? "memory" : "memories"}`}</span>
        <ChevronIcon size={11} />
      </summary>
      <ul>
        {items.map((item) => {
          const Icon = ICONS[item.ref.type];
          const body = (
            <>
              <span className="used-icon" title={TYPE_LABELS[item.ref.type]}>
                <Icon size={13} />
              </span>
              <span className="used-main">
                <span className="used-text" title={item.text}>
                  {truncate(item.text, 140)}
                </span>
                <span className="used-reasons">
                  {item.possiblyOutdated && (
                    <span className="chip warn">
                      <AlertIcon size={11} /> possibly outdated
                    </span>
                  )}
                  {item.reasons.map((r) => (
                    <span key={r} className="chip reason">
                      {reasonLabel(r)}
                    </span>
                  ))}
                </span>
              </span>
            </>
          );
          const open = props.onOpenMemory;
          return (
            <li key={`${item.ref.type}:${item.ref.id}`}>
              {item.ref.type === "memory" && open ? (
                <button type="button" className="used-item" onClick={() => open(item.ref.id)} title="Open in Memory">
                  {body}
                </button>
              ) : (
                <div className="used-item static">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
