$(function() {
    var $modal_cancelreservation = $('#modal_cancelreservation');

    /**
     * キャンセル(確定)
     * @function cancel
     * @returns {void}
     */
    var cancel = function() {
        var $dfd = $.Deferred();
        $('.btn-close').hide();
        var $error_message = $('#error_cancel').text('');
        var payment_no = $modal_cancelreservation[0].getAttribute('data-paymentNo');
        $error_message.text('');
        $.ajax({
            dataType: 'json',
            url: '/inquiry/search/cancel',
            type: 'POST',
            data: {
                payment_no: payment_no
            }
        }).done(function(data) {
            if (!data.error) {
                $modal_cancelreservation.modal('hide');
                $('#modal_completed').modal({
                    backdrop: 'static',
                    keyboard: false
                });
                return;
            }
            $error_message.text(data.error);
        }).fail(function(jqxhr, textStatus, error) {
            console.error(jqxhr, textStatus, error);
            $error_message.text(error);
        }).always(function() {
            $('.btn-close').show();
            $dfd.resolve();
        });
        return $dfd.promise();
    };

    // キャンセル(ポップアップ表示)
    $(document).on('click', '.btn-cancel', function(event) {
        event.preventDefault();
        $modal_cancelreservation.modal({
            backdrop: 'static',
            keyboard: false
        }).click(function(e) {
            e.stopPropagation();
        });
    });

    // キャンセル(確定)
    var busy_cancel = false;
    $('#btn_execcancel').click(function(e) {
        e.preventDefault();
        if (busy_cancel) { return false; }
        busy_cancel = true;
        var $btn = $(this);
        $btn.addClass('is-processing');
        cancel().always(function() {
            $btn.removeClass('is-processing');
            busy_cancel = false;
        });
    });
});
