interface Props {
  activity: string;
}

export function ActivityTicker({ activity }: Props) {
  return (
    <div className="ticker">
      {activity ? (
        <>
          <span className="ticker-arrow ticker-active">&rarr;</span>
          <span className="ticker-active">
            {activity.length > 60 ? activity.slice(0, 60) + "..." : activity}
          </span>
        </>
      ) : (
        <span>(idle)</span>
      )}
    </div>
  );
}
