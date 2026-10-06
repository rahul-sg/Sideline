import { useStore } from '../lib/store';
import { useData } from '../lib/teams';
import { SiteFooter } from '../ui/SiteFooter';

const fmt = (n: number) => n.toLocaleString('en-US');

export function About() {
  const index = useData((s) => s.index);
  const setMode = useStore((s) => s.setMode);
  const tracked = index?.games.filter((g) => !/video/i.test(g.source ?? '')) ?? [];
  const plays = tracked.reduce((a, g) => a + g.plays, 0);

  return (
    <div className="page page--doc">
      <div className="page__inner doc">
        <header className="page__head">
          <div>
            <p className="eyebrow">About</p>
            <h1>How Sideline works</h1>
            <p>
              Sideline replays real NFL plays in 3D. Every position you see comes from the NFL’s player tracking, or, for plays labelled as video
              estimates, from a computer-vision pipeline checked against that tracking. Here’s where each piece comes from and how sure it is.
            </p>
          </div>
        </header>

        <section className="doc__section">
          <h2>The data</h2>
          <div className="doc__table">
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>What it covers</th>
                  <th>Used for</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>NFL Big Data Bowl 2026</td>
                  <td>Every pass play of the 2023 season: the quarterback, route runners and coverage defenders, until the ball arrives</td>
                  <td>Replay, QB Read, Route Finder</td>
                </tr>
                <tr>
                  <td>NFL Big Data Bowl sample game</td>
                  <td>Chiefs at Patriots, 2017 Week 1: every snap, all 22 players and the ball</td>
                  <td>Full-play replays, and the answer key for video estimates</td>
                </tr>
                <tr>
                  <td>nflverse</td>
                  <td>Play-by-play since 1999, rosters, schedules, who was on the field</td>
                  <td>Down and distance, expected points, win probability, This Week, player names</td>
                </tr>
                <tr>
                  <td>Mixamo</td>
                  <td>Motion-captured running, backpedalling, throwing and catching</td>
                  <td>How players move between tracked positions</td>
                </tr>
              </tbody>
            </table>
          </div>
          {index && (
            <p className="doc__note">
              Built into this copy: {fmt(plays)} plays from {fmt(tracked.length)} games
              {index.routeCount ? `, ${fmt(index.routeCount)} routes` : ''} and {fmt(index.qbPool.length)} QB Read plays.
            </p>
          )}
        </section>

        <section className="doc__section">
          <h2>From tracking to 3D</h2>
          <ol className="doc__steps">
            <li>
              <h3>Line up every play the same way</h3>
              <p>Plays are turned so the offense always moves left to right, then the line of scrimmage, first-down line and key moments (snap, throw, catch) are pulled from the data.</p>
            </li>
            <li>
              <h3>Work out who has the ball</h3>
              <p>Raw ball tracking jumps around, so possession is rebuilt from the play’s events and its official description, and the ball is put in the right player’s hands.</p>
            </li>
            <li>
              <h3>Move the players</h3>
              <p>Motion capture is matched to each player’s real speed and direction, and the throw, catch and celebration are timed to the frames they happened on.</p>
            </li>
            <li>
              <h3>Put it on a real field</h3>
              <p>The field, markings and stadium are built to NFL dimensions, and the cameras copy the ones you know from TV.</p>
            </li>
          </ol>
        </section>

        <section className="doc__section">
          <h2>Measured, and modelled</h2>
          <div className="doc__cols">
            <div>
              <h3>Measured</h3>
              <ul>
                <li>Where every tracked player is, ten times a second</li>
                <li>Speed, and which way each player faces (2023)</li>
                <li>When the snap, throw and catch happened</li>
                <li>The result, expected points and win probability (nflverse models)</li>
              </ul>
            </div>
            <div>
              <h3>Modelled</h3>
              <ul>
                <li>How high the ball is in the air (tracking is flat)</li>
                <li>Body poses and running motion</li>
                <li>Players are mannequins in team colors, not likenesses</li>
                <li>2023 plays track no linemen; players untracked after the throw are drawn faded</li>
                <li>2017: facing direction is worked out from movement</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="doc__section">
          <h2>Plays from broadcast video</h2>
          <p>
            For games without public tracking, a vision pipeline estimates positions from the TV broadcast. It reads the game clock to find each
            play, fits the painted field lines to work out where the camera points, detects and follows every player (YOLO11 and ByteTrack), splits
            the teams by jersey color and reads jersey numbers (EasyOCR), keeping only numbers of the 22 players on the field for that play. Video is
            analysed on this computer; footage isn’t stored in or shown by the app.
          </p>
          <p>It was checked against the NFL’s tracking of every play in a condensed broadcast of the 2017 Chiefs–Patriots game:</p>
          <div className="doc__table">
            <table>
              <tbody>
                <tr>
                  <td>Plays found in the video and started with no manual setup</td>
                  <td className="num">50 of 68</td>
                </tr>
                <tr>
                  <td>Position error across those plays (median / 90th percentile)</td>
                  <td className="num">1.5 / 3.9 yd</td>
                </tr>
                <tr>
                  <td>Best single play (Smith to Hill, 75-yard touchdown)</td>
                  <td className="num">0.6 yd</td>
                </tr>
                <tr>
                  <td>Jersey names right, checked by eye (40 at random)</td>
                  <td className="num">91% of readable</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="doc__note">
            Video estimates only show what the camera saw: players off screen are faded, about four players per play get a name, and the ball
            isn’t tracked yet.
          </p>
        </section>

        <section className="doc__section">
          <h2>Credits</h2>
          <p>
            Tracking data from the NFL Big Data Bowl (CC BY-NC 4.0) and the NFL’s public sample game; play-by-play, rosters and schedules from
            nflverse; animation from Mixamo. Built with React, three.js and React Three Fiber, with Ultralytics YOLO11, ByteTrack, OpenCV and EasyOCR
            for video.
          </p>
          <p>Sideline is an independent project and isn’t affiliated with or endorsed by the NFL, its teams or players.</p>
          <div className="hero__actions">
            <button className="btn btn--primary btn--lg" onClick={() => setMode('theater')}>
              Watch a play
            </button>
            <button className="btn btn--lg" onClick={() => setMode('home')}>
              Back to home
            </button>
          </div>
        </section>
      </div>
      <SiteFooter />
    </div>
  );
}
