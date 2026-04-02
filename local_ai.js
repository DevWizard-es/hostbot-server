/**
 * Smart Rule-based "Local AI" Engine
 * ⚡ Lightweight fallback for when LLM APIs fail on 512MB RAM servers.
 */

function getLocalResponse(query, biz, menu) {
  const text = query.toLowerCase();
  
  // 1. GREETINGS
  if (text.includes('hola') || text.includes('buenos dias') || text.includes('buenas tardes')) {
    return `¡Hola! 👋 Soy el asistente virtual de ${biz.name}. ¿En qué puedo ayudarte hoy?`;
  }

  // 2. MENU / CATALOG
  if (text.includes('menu') || text.includes('carta') || text.includes('comer') || text.includes('beber') || text.includes('que hay') || text.includes('plato') || text.includes('precio')) {
    if (!menu || menu.length === 0) {
      return `Puedes consultar nuestra carta digital aquí mismo en la web. No tengo los platos cargados ahora mismo, ¡pero te aseguro que todo está delicioso!`;
    }
    const menuList = menu.slice(0, 5).map(item => `- ${item.name}: ${item.price}€`).join('\n');
    return `Aquí tienes algunos de nuestros productos destacados:\n${menuList}\n\nPuedes ver la carta completa en la sección de Menú. 🍕🍟`;
  }

  // 3. LOCATION / ADDRESS
  if (text.includes('donde') || text.includes('ubicacion') || text.includes('direccion') || text.includes('donde estan') || text.includes('mapa') || text.includes('ir')) {
    return `Nos encontramos en: ${biz.address || 'nuestro local (puedes consultar el mapa en el Bio Link)'}. ¡Esperamos verte pronto! 📍`;
  }

  // 4. HOURS / SCHEDULE
  if (text.includes('horario') || text.includes('cuando abren') || text.includes('esta abierto') || text.includes('hora')) {
    return `Nuestro horario es: ${biz.schedule || 'de lunes a domingo (consúltalo en el Bio Link)'}. 🕙`;
  }

  // 5. RESERVATIONS
  if (text.includes('reserva') || text.includes('reservar') || text.includes('mesa') || text.includes('comensales')) {
    return `¡Claro! Puedes hacer una reserva ahora mismo pulsando el botón de "Hacer una reserva" en nuestra página principal. Solo dinos la fecha y hora. 📅`;
  }

  // 6. CONTACT / PHONE
  if (text.includes('telefono') || text.includes('contacto') || text.includes('hablar') || text.includes('persona') || text.includes('llamar')) {
    return `Si necesitas hablar con una persona, puedes llamarnos al ${biz.phone || 'nuestro número de contacto'}. 📞`;
  }

  // 7. DEFAULT
  return `¡Gracias por tu mensaje! Soy el asistente automático de ${biz.name} y estoy aquí para ayudarte con el menú, reservas y horarios. ¿Quieres saber algo específico? 😊`;
}

module.exports = { getLocalResponse };
