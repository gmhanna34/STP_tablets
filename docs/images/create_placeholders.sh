#!/bin/bash
# Generate SVG placeholder images for PAGE_GUIDE.md screenshots
# Replace each .svg with an actual .png screenshot of the same name

DIR="$(dirname "$0")"

create_placeholder() {
    local filename="$1"
    local label="$2"
    # Wrap long labels
    local line1 line2
    if [ ${#label} -gt 40 ]; then
        line1="${label:0:40}"
        line2="${label:40}"
        cat > "$DIR/$filename" << EOF
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450">
  <rect width="800" height="450" fill="#1a1a2e" rx="12"/>
  <rect x="4" y="4" width="792" height="442" fill="none" stroke="#4a4a6a" stroke-width="2" stroke-dasharray="12,6" rx="10"/>
  <text x="400" y="190" text-anchor="middle" fill="#8888aa" font-family="system-ui,sans-serif" font-size="22">SCREENSHOT NEEDED</text>
  <text x="400" y="230" text-anchor="middle" fill="#ccccdd" font-family="system-ui,sans-serif" font-size="18" font-weight="bold">$line1</text>
  <text x="400" y="255" text-anchor="middle" fill="#ccccdd" font-family="system-ui,sans-serif" font-size="18" font-weight="bold">$line2</text>
  <text x="400" y="300" text-anchor="middle" fill="#666680" font-family="system-ui,sans-serif" font-size="14">Replace this file with an actual screenshot (.png)</text>
</svg>
EOF
    else
        cat > "$DIR/$filename" << EOF
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450">
  <rect width="800" height="450" fill="#1a1a2e" rx="12"/>
  <rect x="4" y="4" width="792" height="442" fill="none" stroke="#4a4a6a" stroke-width="2" stroke-dasharray="12,6" rx="10"/>
  <text x="400" y="195" text-anchor="middle" fill="#8888aa" font-family="system-ui,sans-serif" font-size="22">SCREENSHOT NEEDED</text>
  <text x="400" y="235" text-anchor="middle" fill="#ccccdd" font-family="system-ui,sans-serif" font-size="18" font-weight="bold">$label</text>
  <text x="400" y="290" text-anchor="middle" fill="#666680" font-family="system-ui,sans-serif" font-size="14">Replace this file with an actual screenshot (.png)</text>
</svg>
EOF
    fi
}

create_placeholder "01-nav-bar-status-indicators.svg"      "Navigation bar with status indicators"
create_placeholder "02-home-page.svg"                       "Home page"
create_placeholder "03-main-church-full-view.svg"           "Main Church page — full view"
create_placeholder "04-main-church-progress-overlay.svg"    "Progress overlay during All Systems On"
create_placeholder "05-main-church-video-sources.svg"       "Video source buttons with active source highlighted"
create_placeholder "06-chapel-page.svg"                     "Chapel page"
create_placeholder "07-social-hall-page.svg"                "Social Hall page"
create_placeholder "08-gym-page.svg"                        "Gym page"
create_placeholder "09-conference-room-page.svg"            "Conference Room page"
create_placeholder "10-live-stream-full-view.svg"           "Live Stream page — full view"
create_placeholder "11-live-stream-scene-buttons.svg"       "Scene buttons with active scene highlighted"
create_placeholder "12-ptz-control-panel.svg"               "PTZ camera control panel"
create_placeholder "13-source-routing-tabs.svg"             "Source Routing page tabs"
create_placeholder "14-announcements-presets.svg"           "Announcements tab with presets"
create_placeholder "15-security-page.svg"                   "Security page"
create_placeholder "16-health-page-service-cards.svg"       "Health page with service cards"
create_placeholder "17-occupancy-page-charts.svg"           "Occupancy page with charts"
create_placeholder "18-settings-page-tabs.svg"              "Settings page tabs"
create_placeholder "19-settings-audio-mixer.svg"            "Audio mixer faders and controls"

echo "Created $(ls "$DIR"/*.svg | wc -l) placeholder images"
