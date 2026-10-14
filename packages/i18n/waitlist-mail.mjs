import {createLocalization, ObjectCatalogue} from './index.mjs';

// A server-mail contribution to the same Bab translation capability used by
// the portal. Keeping it separate avoids coupling mail to application state.
const spanish={
 'Confirm your {brand} waitlist request':'Confirma tu solicitud para la lista de espera de {brand}',
 'Confirm that you want your email added to the {brand} waitlist.':'Confirma que quieres añadir tu correo a la lista de espera de {brand}.',
 'This link expires in ten minutes. Opening it does not join the waitlist; confirm on the page. Joining does not create an account or reserve a place.':'Este enlace caduca en diez minutos. Abrirlo no te añade a la lista de espera; confirma en la página. Unirte no crea una cuenta ni reserva una plaza.',
 'If you did not request this message, ignore it. Your address will not be added without confirmation.':'Si no solicitaste este mensaje, ignóralo. Tu dirección no se añadirá sin confirmación.'
};
export function waitlistMailLocalization(locale='en'){
 if(!['en','es'].includes(locale))throw new TypeError('Unsupported waitlist mail language.');
 return createLocalization({locale,catalogue:new ObjectCatalogue({'':locale==='es'?spanish:{}})});
}
