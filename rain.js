(() => {
  if (window.__raincheckRainStarted) return;
  window.__raincheckRainStarted = true;

  const rain = document.createElement("div");
  rain.className = "rainOverlay";
  for (let i = 0; i < 300; i++) {
    const drop = document.createElement("span");
    drop.style.left = `${Math.random() * 100}%`;
    drop.style.animationDelay = `${Math.random() * 0.6}s`;
    drop.style.animationDuration = `${0.55 + Math.random() * 0.5}s`;
    drop.style.opacity = (0.25 + Math.random() * 0.55).toFixed(2);
    drop.style.transform = `translateY(${-(Math.random() * 120)}px)`;
    rain.appendChild(drop);
  }
  document.body.appendChild(rain);

  const removeRain = () => {
    rain.classList.add("fade");
    setTimeout(() => rain.remove(), 700);
  };

  setTimeout(removeRain, 3000);
})();
