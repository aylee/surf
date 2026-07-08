import { Activity, RadioTower, Waves } from "lucide-react";
import { NORCAL_SPOTS, buildFixtureForecast } from "@surf/forecast-core";

const generatedAt = new Date("2026-07-08T12:00:00.000Z");

export function App() {
  const previews = NORCAL_SPOTS.map((spot) => ({
    spot,
    best: buildFixtureForecast(spot.id, generatedAt).windows[0]!
  }));

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">public-data surf engine</p>
          <h1>NorCal forecast console</h1>
        </div>
        <div className="statusPill">
          <RadioTower size={16} />
          Bootstrap mode
        </div>
      </header>

      <section className="summaryBand">
        <div>
          <Waves size={24} />
          <span>NOAA/CDIP-first forecast stack</span>
        </div>
        <div>
          <Activity size={24} />
          <span>Deterministic scoring before narrative reports</span>
        </div>
      </section>

      <section className="spotGrid" aria-label="V1 NorCal spots">
        {previews.map(({ spot, best }) => (
          <article key={spot.id} className="spotCard">
            <div className="spotHeader">
              <h2>{spot.name}</h2>
              <span>{best.qualityLabel}</span>
            </div>
            <div className="scoreRow">
              <strong>{best.score}</strong>
              <p>{best.explanation}</p>
            </div>
            <dl>
              <div>
                <dt>Tide station</dt>
                <dd>{spot.tideStation}</dd>
              </div>
              <div>
                <dt>Reference buoys</dt>
                <dd>{spot.referenceBuoys.join(", ")}</dd>
              </div>
            </dl>
          </article>
        ))}
      </section>
    </main>
  );
}
